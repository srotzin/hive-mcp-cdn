/**
 * Two-tier cache: in-memory LRU (hot) + SQLite (warm).
 *
 * Reads check LRU first; on miss, fall back to SQLite and promote.
 * Writes go to both. ETag is the SHA-256 hex of the body. Bytes
 * served per response are tracked on the entry so the egress meter
 * can read them after the response is dispatched.
 *
 * No outbound network. Pure storage. The MCP shim layers x402 and
 * cache-control headers on top of these primitives.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.CDN_DB_PATH || '/tmp/cdn.db';
const LRU_MAX_ENTRIES = Number(process.env.CDN_LRU_MAX_ENTRIES) || 1024;
const LRU_MAX_BYTES = Number(process.env.CDN_LRU_MAX_BYTES) || 64 * 1024 * 1024;
const DEFAULT_TTL_S = Number(process.env.CDN_DEFAULT_TTL_S) || 300;
const MAX_OBJECT_BYTES = Number(process.env.CDN_MAX_OBJECT_BYTES) || 4 * 1024 * 1024;

try { mkdirSync(dirname(DB_PATH), { recursive: true }); } catch {}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    body BLOB NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    etag TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 0,
    last_hit_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS cache_expires_idx ON cache(expires_at);

  CREATE TABLE IF NOT EXISTS egress (
    day TEXT PRIMARY KEY,
    requests INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 0,
    misses INTEGER NOT NULL DEFAULT 0,
    bytes_served INTEGER NOT NULL DEFAULT 0,
    revenue_usd REAL NOT NULL DEFAULT 0
  );
`);

const stmts = {
  put: db.prepare(`
    INSERT INTO cache (key, body, content_type, etag, size_bytes, created_at, expires_at, hit_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(key) DO UPDATE SET
      body=excluded.body,
      content_type=excluded.content_type,
      etag=excluded.etag,
      size_bytes=excluded.size_bytes,
      created_at=excluded.created_at,
      expires_at=excluded.expires_at
  `),
  get: db.prepare('SELECT * FROM cache WHERE key = ?'),
  bumpHit: db.prepare('UPDATE cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE key = ?'),
  delete: db.prepare('DELETE FROM cache WHERE key = ?'),
  count: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM cache'),
  sweepExpired: db.prepare('DELETE FROM cache WHERE expires_at <= ?'),
  egressUpsert: db.prepare(`
    INSERT INTO egress (day, requests, hits, misses, bytes_served, revenue_usd)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET
      requests = requests + excluded.requests,
      hits = hits + excluded.hits,
      misses = misses + excluded.misses,
      bytes_served = bytes_served + excluded.bytes_served,
      revenue_usd = revenue_usd + excluded.revenue_usd
  `),
  egressRead: db.prepare('SELECT * FROM egress WHERE day = ?'),
};

// LRU: Map preserves insertion order, so re-insert on access bumps recency.
const lru = new Map();
let lruBytes = 0;

function lruEvictTo(targetEntries, targetBytes) {
  const it = lru.keys();
  while ((lru.size > targetEntries || lruBytes > targetBytes) && lru.size > 0) {
    const oldestKey = it.next().value;
    if (oldestKey === undefined) break;
    const entry = lru.get(oldestKey);
    lru.delete(oldestKey);
    lruBytes -= entry?.size_bytes || 0;
  }
}

function lruSet(key, entry) {
  if (lru.has(key)) {
    const prev = lru.get(key);
    lruBytes -= prev.size_bytes || 0;
    lru.delete(key);
  }
  lru.set(key, entry);
  lruBytes += entry.size_bytes;
  lruEvictTo(LRU_MAX_ENTRIES, LRU_MAX_BYTES);
}

function lruGet(key) {
  if (!lru.has(key)) return null;
  const entry = lru.get(key);
  lru.delete(key);
  lru.set(key, entry);
  return entry;
}

function lruDelete(key) {
  if (!lru.has(key)) return;
  const e = lru.get(key);
  lruBytes -= e.size_bytes || 0;
  lru.delete(key);
}

function nowSec() { return Math.floor(Date.now() / 1000); }
function utcDay() { return new Date().toISOString().slice(0, 10); }
function sha256Hex(buf) { return createHash('sha256').update(buf).digest('hex'); }

export function makeKey(rawKey) {
  if (typeof rawKey !== 'string' || rawKey.length === 0) return null;
  if (rawKey.length > 512) return null;
  return rawKey;
}

export function put({ key, body, content_type, ttl_s }) {
  const k = makeKey(key);
  if (!k) return { ok: false, error: 'invalid_key' };
  let buf;
  if (Buffer.isBuffer(body)) buf = body;
  else if (typeof body === 'string') buf = Buffer.from(body, 'utf8');
  else if (body && typeof body === 'object') buf = Buffer.from(JSON.stringify(body), 'utf8');
  else return { ok: false, error: 'invalid_body' };

  if (buf.length > MAX_OBJECT_BYTES) return { ok: false, error: 'object_too_large', max: MAX_OBJECT_BYTES };

  const ttl = Number.isFinite(ttl_s) && ttl_s > 0 ? Math.min(ttl_s, 86400 * 7) : DEFAULT_TTL_S;
  const created = nowSec();
  const expires = created + ttl;
  const ct = (content_type && typeof content_type === 'string') ? content_type.slice(0, 128) : 'application/octet-stream';
  const etag = `"${sha256Hex(buf).slice(0, 32)}"`;

  stmts.put.run(k, buf, ct, etag, buf.length, created, expires, );
  lruSet(k, { key: k, body: buf, content_type: ct, etag, size_bytes: buf.length, created_at: created, expires_at: expires });

  return { ok: true, key: k, etag, size_bytes: buf.length, ttl_s: ttl, expires_at: expires };
}

export function get(key) {
  const k = makeKey(key);
  if (!k) return { ok: false, error: 'invalid_key' };
  const now = nowSec();

  const hot = lruGet(k);
  if (hot) {
    if (hot.expires_at <= now) {
      lruDelete(k);
      stmts.delete.run(k);
      return { ok: false, error: 'not_found' };
    }
    stmts.bumpHit.run(now, k);
    return { ok: true, hit: true, tier: 'hot', ...hot };
  }

  const row = stmts.get.get(k);
  if (!row) return { ok: false, error: 'not_found' };
  if (row.expires_at <= now) {
    stmts.delete.run(k);
    return { ok: false, error: 'not_found' };
  }
  const entry = {
    key: row.key,
    body: row.body,
    content_type: row.content_type,
    etag: row.etag,
    size_bytes: row.size_bytes,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
  lruSet(k, entry);
  stmts.bumpHit.run(now, k);
  return { ok: true, hit: true, tier: 'warm', ...entry };
}

export function purge(key) {
  const k = makeKey(key);
  if (!k) return { ok: false, error: 'invalid_key' };
  const row = stmts.get.get(k);
  lruDelete(k);
  const r = stmts.delete.run(k);
  return { ok: true, purged: r.changes > 0 || !!row, key: k };
}

export function stats() {
  const c = stmts.count.get();
  return {
    entries: c.n,
    warm_bytes: c.bytes,
    hot_entries: lru.size,
    hot_bytes: lruBytes,
    lru_max_entries: LRU_MAX_ENTRIES,
    lru_max_bytes: LRU_MAX_BYTES,
    default_ttl_s: DEFAULT_TTL_S,
    max_object_bytes: MAX_OBJECT_BYTES,
    db_path: DB_PATH,
  };
}

export function recordRequest({ hit, bytes, revenue_usd }) {
  const day = utcDay();
  stmts.egressUpsert.run(day, 1, hit ? 1 : 0, hit ? 0 : 1, bytes || 0, revenue_usd || 0);
}

export function todayMetrics() {
  const day = utcDay();
  const row = stmts.egressRead.get(day);
  return row || { day, requests: 0, hits: 0, misses: 0, bytes_served: 0, revenue_usd: 0 };
}

export function sweep() {
  const r = stmts.sweepExpired.run(nowSec());
  return { swept: r.changes };
}

setInterval(() => {
  try { sweep(); } catch {}
}, 60_000).unref?.();
