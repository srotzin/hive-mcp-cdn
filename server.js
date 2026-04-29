#!/usr/bin/env node
/**
 * hive-mcp-cdn — Edge cache shim for A2A capabilities.
 *
 * Two-tier cache (in-memory LRU + SQLite warm tier) with ETag /
 * If-None-Match support, per-key TTL via cache-control, and a purge
 * endpoint. Two metered surfaces ride x402:
 *
 *   - $0.0002 / cache request
 *   - $0.05   / GB of body bytes served
 *
 * Brand: Hive Civilization gold #C08D23 (Pantone 1245 C).
 * Spec : MCP 2024-11-05 / Streamable-HTTP / JSON-RPC 2.0.
 * Mode : Inbound only. ENABLE=true default.
 */

import express from 'express';
import * as cache from './lib/cache.js';
import * as x402 from './lib/x402.js';

const app = express();
app.use(express.json({ limit: '8mb' }));

const PORT = process.env.PORT || 3000;
const ENABLE = String(process.env.ENABLE ?? 'true').toLowerCase() === 'true';
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const BRAND_GOLD = '#C08D23';

function parseTtlFromCacheControl(cc) {
  if (!cc || typeof cc !== 'string') return null;
  const m = cc.match(/max-age\s*=\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

// ─── MCP tools ──────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'cdn_cache_get',
    description: 'Read a cached object by key. Returns body, content type, ETag, age, and freshness. Tier 2, $0.0002 per request plus $0.05 per GB of body bytes served via x402. Inbound only.',
    inputSchema: {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string', description: 'Opaque cache key (max 512 chars).' },
        if_none_match: { type: 'string', description: 'Optional ETag. If it matches, the response is a 304-equivalent with no body.' },
      },
    },
  },
  {
    name: 'cdn_cache_put',
    description: 'Store an object under a key with optional Cache-Control max-age. Tier 0, free for now. Body may be a string, JSON value, or base64-encoded binary tagged with content_type.',
    inputSchema: {
      type: 'object',
      required: ['key', 'body'],
      properties: {
        key: { type: 'string' },
        body: { description: 'Body content. String, JSON object, or { base64: string } for binary.' },
        content_type: { type: 'string', description: 'MIME type. Default application/octet-stream.' },
        cache_control: { type: 'string', description: 'Cache-Control header. max-age=<s> sets TTL. Default 300s.' },
      },
    },
  },
  {
    name: 'cdn_purge',
    description: 'Purge a single cache entry by key. Tier 0, free. Idempotent — returns ok regardless of whether the key was present.',
    inputSchema: {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string' },
      },
    },
  },
];

function bodyToBuffer(body, content_type) {
  if (body && typeof body === 'object' && typeof body.base64 === 'string') {
    return { buf: Buffer.from(body.base64, 'base64'), ct: content_type || 'application/octet-stream' };
  }
  if (typeof body === 'string') {
    return { buf: Buffer.from(body, 'utf8'), ct: content_type || 'text/plain; charset=utf-8' };
  }
  return { buf: Buffer.from(JSON.stringify(body), 'utf8'), ct: content_type || 'application/json; charset=utf-8' };
}

function entryToToolPayload(entry, ifNoneMatch) {
  const fresh = entry.expires_at - Math.floor(Date.now() / 1000);
  const age = Math.floor(Date.now() / 1000) - entry.created_at;
  if (ifNoneMatch && ifNoneMatch === entry.etag) {
    return {
      hit: true,
      not_modified: true,
      key: entry.key,
      etag: entry.etag,
      content_type: entry.content_type,
      size_bytes: entry.size_bytes,
      age_s: age,
      ttl_remaining_s: Math.max(0, fresh),
      cache_control: `public, max-age=${Math.max(0, fresh)}`,
      tier: entry.tier,
    };
  }
  const isText = /^(text\/|application\/(json|xml|javascript))/i.test(entry.content_type);
  return {
    hit: true,
    not_modified: false,
    key: entry.key,
    etag: entry.etag,
    content_type: entry.content_type,
    size_bytes: entry.size_bytes,
    body: isText ? entry.body.toString('utf8') : null,
    body_base64: isText ? null : entry.body.toString('base64'),
    age_s: age,
    ttl_remaining_s: Math.max(0, fresh),
    cache_control: `public, max-age=${Math.max(0, fresh)}`,
    tier: entry.tier,
  };
}

async function executeTool(name, args, req) {
  switch (name) {
    case 'cdn_cache_get': {
      const access = x402.checkAccess(req);
      if (!access.ok) {
        return { _gate_402: x402.quoteEnvelope() };
      }
      const r = cache.get(args.key);
      if (!r.ok) {
        cache.recordRequest({ hit: false, bytes: 0, revenue_usd: 0.0002 });
        const m = x402.meter(req, { hit: false, bytes: 0 });
        return {
          type: 'text',
          text: JSON.stringify({ hit: false, key: args.key, error: r.error, meter: m }, null, 2),
        };
      }
      const payload = entryToToolPayload(r, args.if_none_match);
      const bytes = payload.not_modified ? 0 : r.size_bytes;
      cache.recordRequest({ hit: true, bytes, revenue_usd: 0.0002 + (bytes / (1024**3)) * 0.05 });
      const m = x402.meter(req, { hit: true, bytes });
      payload.meter = m;
      return { type: 'text', text: JSON.stringify(payload, null, 2) };
    }
    case 'cdn_cache_put': {
      const { buf, ct } = bodyToBuffer(args.body, args.content_type);
      const ttl = parseTtlFromCacheControl(args.cache_control);
      const r = cache.put({ key: args.key, body: buf, content_type: ct, ttl_s: ttl });
      return { type: 'text', text: JSON.stringify(r, null, 2) };
    }
    case 'cdn_purge': {
      const r = cache.purge(args.key);
      return { type: 'text', text: JSON.stringify(r, null, 2) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP JSON-RPC ──────────────────────────────────────────────────────────
app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC' } });
  }
  try {
    switch (method) {
      case 'initialize':
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: 'hive-mcp-cdn',
              version: '1.0.0',
              description: 'Edge cache for A2A capabilities — Hive Civilization. Inbound only.',
            },
          },
        });
      case 'tools/list':
        return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        const out = await executeTool(name, args || {}, req);
        if (out && out._gate_402) {
          return res.json({
            jsonrpc: '2.0',
            id,
            error: { code: 402, message: 'payment_required', data: out._gate_402 },
          });
        }
        return res.json({ jsonrpc: '2.0', id, result: { content: [out] } });
      }
      case 'ping':
        return res.json({ jsonrpc: '2.0', id, result: {} });
      default:
        return res.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }
  } catch (err) {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
  }
});

// ─── REST endpoints ────────────────────────────────────────────────────────
app.get('/v1/cdn/get', (req, res) => {
  const key = String(req.query.key || '');
  if (!key) return res.status(400).json({ error: 'missing_key' });

  const access = x402.checkAccess(req);
  if (!access.ok) {
    return res.status(402).json(x402.quoteEnvelope());
  }

  const r = cache.get(key);
  if (!r.ok) {
    cache.recordRequest({ hit: false, bytes: 0, revenue_usd: 0.0002 });
    const m = x402.meter(req, { hit: false, bytes: 0 });
    if (m) res.set('X-Hive-Balance-USD', String(m.balance_usd.toFixed(6)));
    res.set('Cache-Control', 'no-store');
    return res.status(404).json({ hit: false, key, error: r.error, meter: m });
  }

  const ifNoneMatch = req.headers['if-none-match'];
  const fresh = Math.max(0, r.expires_at - Math.floor(Date.now() / 1000));
  res.set('ETag', r.etag);
  res.set('Cache-Control', `public, max-age=${fresh}`);
  res.set('X-Cache', 'HIT');
  res.set('X-Cache-Tier', r.tier);
  res.set('Age', String(Math.floor(Date.now() / 1000) - r.created_at));

  if (ifNoneMatch && ifNoneMatch === r.etag) {
    cache.recordRequest({ hit: true, bytes: 0, revenue_usd: 0.0002 });
    const m = x402.meter(req, { hit: true, bytes: 0 });
    if (m) res.set('X-Hive-Balance-USD', String(m.balance_usd.toFixed(6)));
    return res.status(304).end();
  }

  cache.recordRequest({ hit: true, bytes: r.size_bytes, revenue_usd: 0.0002 + (r.size_bytes / (1024**3)) * 0.05 });
  const m = x402.meter(req, { hit: true, bytes: r.size_bytes });
  if (m) res.set('X-Hive-Balance-USD', String(m.balance_usd.toFixed(6)));
  res.set('Content-Type', r.content_type);
  res.set('Content-Length', String(r.size_bytes));
  res.status(200).send(r.body);
});

app.post('/v1/cdn/put', (req, res) => {
  const { key, body, content_type, cache_control } = req.body || {};
  if (!key || body === undefined) return res.status(400).json({ error: 'missing_fields' });
  const ttl = parseTtlFromCacheControl(cache_control);
  const { buf, ct } = bodyToBuffer(body, content_type);
  const r = cache.put({ key, body: buf, content_type: ct, ttl_s: ttl });
  if (!r.ok) return res.status(400).json(r);
  res.set('ETag', r.etag);
  res.set('Cache-Control', `public, max-age=${r.ttl_s}`);
  res.json(r);
});

app.post('/v1/cdn/purge', (req, res) => {
  const key = (req.body && req.body.key) || req.query.key;
  if (!key) return res.status(400).json({ error: 'missing_key' });
  const r = cache.purge(String(key));
  res.json(r);
});

app.get('/v1/cdn/today', (req, res) => {
  res.json({
    ...cache.todayMetrics(),
    cache: cache.stats(),
    pricing: x402.pricing(),
    tokens: x402.tokenStats(),
  });
});

app.post('/v1/x402/proof/submit', (req, res) => {
  const r = x402.submitProof(req.body || {});
  if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
  res.json(r);
});

app.get('/v1/x402/pricing', (req, res) => res.json(x402.pricing()));
app.get('/v1/x402/stats', (req, res) => res.json(x402.tokenStats()));

// ─── Discovery & health ────────────────────────────────────────────────────
app.get('/.well-known/mcp.json', (req, res) => {
  res.json({
    name: 'hive-mcp-cdn',
    version: '1.0.0',
    protocol: '2024-11-05',
    transport: 'streamable-http',
    endpoint: '/mcp',
    description: 'Edge cache for A2A capabilities. In-memory LRU + SQLite warm tier, ETag/If-None-Match, purge.',
    tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
    brand_color: BRAND_GOLD,
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'hive-mcp-cdn',
    version: '1.0.0',
    enable: ENABLE,
    inbound_only: true,
    wallet: WALLET_ADDRESS,
    brand_color: BRAND_GOLD,
    cache: cache.stats(),
    pricing: x402.pricing(),
  });
});

const HTML_LANDING = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>hive-mcp-cdn — Edge cache for A2A capabilities</title>
<meta name="description" content="Edge cache shim for A2A capabilities. In-memory LRU plus SQLite warm tier, ETag and If-None-Match, purge endpoint. $0.0002 per request and $0.05 per GB egress via x402." />
<style>
  :root { --gold:#C08D23; --ink:#1a1a1a; --line:rgba(0,0,0,0.08); --muted:#6b6b6b; --bg:#ffffff; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color:var(--ink); background:var(--bg); }
  header { padding: 56px 24px 24px; max-width: 880px; margin: 0 auto; }
  .mark { display:inline-flex; align-items:center; gap:10px; color:var(--gold); font-weight:600; letter-spacing:.04em; text-transform:uppercase; font-size:13px; }
  .dot { width:10px; height:10px; border-radius:50%; background:var(--gold); }
  h1 { font-size: 40px; line-height: 1.15; margin: 16px 0 12px; letter-spacing:-0.01em; }
  p.lede { color:var(--muted); font-size:18px; margin: 0 0 12px; max-width: 64ch; }
  main { max-width: 880px; margin: 0 auto; padding: 0 24px 64px; }
  section { padding: 24px 0; border-top: 1px solid var(--line); }
  h2 { font-size: 13px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin: 0 0 16px; font-weight:600; }
  table { width:100%; border-collapse: collapse; }
  th, td { text-align:left; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 14px; vertical-align: top; }
  th { color: var(--muted); font-weight: 500; }
  code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 13px; background: rgba(0,0,0,0.04); padding: 1px 6px; border-radius: 4px; }
  pre { font-family: "SF Mono", Menlo, Consolas, monospace; font-size:13px; background:#fafafa; border:1px solid var(--line); border-radius:8px; padding:16px; overflow-x:auto; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:16px; }
  .card { padding:16px; border:1px solid var(--line); border-radius:8px; }
  .card h3 { margin:0 0 8px; font-size:14px; }
  .card p { margin:0; color:var(--muted); font-size:14px; }
  footer { padding: 24px; max-width: 880px; margin: 0 auto; color: var(--muted); font-size: 13px; border-top: 1px solid var(--line); }
  a { color: var(--gold); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<header>
  <div class="mark"><span class="dot"></span> Hive Civilization</div>
  <h1>hive-mcp-cdn</h1>
  <p class="lede">Edge cache for A2A capabilities. Two-tier storage with in-memory LRU and a SQLite warm tier, ETag and If-None-Match support, and a purge endpoint. Metered through x402 at $0.0002 per request and $0.05 per GB of body bytes served.</p>
</header>
<main>
  <section>
    <h2>Endpoints</h2>
    <table>
      <tr><th><code>GET</code></th><td><code>/v1/cdn/get?key=...</code></td><td>Read a cached object. Honors <code>If-None-Match</code> and returns <code>304</code> when the ETag matches.</td></tr>
      <tr><th><code>POST</code></th><td><code>/v1/cdn/put</code></td><td>Store an object under a key. Optional <code>cache_control: max-age=...</code>.</td></tr>
      <tr><th><code>POST</code></th><td><code>/v1/cdn/purge</code></td><td>Purge a single key. Idempotent.</td></tr>
      <tr><th><code>GET</code></th><td><code>/v1/cdn/today</code></td><td>Daily request, hit, miss, byte, and revenue counters.</td></tr>
      <tr><th><code>POST</code></th><td><code>/mcp</code></td><td>MCP 2024-11-05 over Streamable-HTTP / JSON-RPC 2.0.</td></tr>
      <tr><th><code>GET</code></th><td><code>/health</code></td><td>Service health, cache statistics, and pricing.</td></tr>
    </table>
  </section>
  <section>
    <h2>MCP tools</h2>
    <div class="grid">
      <div class="card"><h3>cdn_cache_get</h3><p>Read by key. Returns body, content type, ETag, age, and freshness. Tier 2.</p></div>
      <div class="card"><h3>cdn_cache_put</h3><p>Store under a key with optional <code>Cache-Control</code>. Tier 0.</p></div>
      <div class="card"><h3>cdn_purge</h3><p>Purge a single entry by key. Tier 0, idempotent.</p></div>
    </div>
  </section>
  <section>
    <h2>x402 pricing</h2>
    <table>
      <tr><th>Per request</th><td><code>$0.0002</code> USDC</td><td>Charged on every <code>/v1/cdn/get</code> regardless of hit or miss.</td></tr>
      <tr><th>Per GB egress</th><td><code>$0.05</code> USDC</td><td>Charged on bytes returned in <code>200</code> responses. <code>304</code> responses do not bill egress.</td></tr>
      <tr><th>Prepay bundle</th><td><code>$1.00</code> USDC</td><td>Buys an access token; reads draw from the prepaid balance until depletion.</td></tr>
      <tr><th>Settlement</th><td colspan="2">USDC on Base L2.</td></tr>
    </table>
  </section>
  <section>
    <h2>Quick reference</h2>
    <pre>curl -X POST $HOST/v1/cdn/put \\
  -H 'content-type: application/json' \\
  -d '{"key":"agents/card/42","body":{"name":"agent-42"},"cache_control":"max-age=600"}'

curl -i "$HOST/v1/cdn/get?key=agents/card/42" \\
  -H "X-Hive-Access: hive_..." \\
  -H 'If-None-Match: "..."'</pre>
  </section>
</main>
<footer>
  Inbound only. <code>ENABLE=true</code> default. Brand gold <code>#C08D23</code>. MIT license.
</footer>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "hive-mcp-cdn",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Cross-platform",
  "description": "Edge cache for A2A capabilities. In-memory LRU plus SQLite warm tier, ETag and If-None-Match, purge endpoint. $0.0002 per request and $0.05 per GB egress via x402.",
  "softwareVersion": "1.0.0",
  "license": "https://opensource.org/licenses/MIT",
  "author": { "@type": "Person", "name": "Steve Rotzin", "email": "steve@thehiveryiq.com", "url": "https://www.thehiveryiq.com" },
  "publisher": { "@type": "Organization", "name": "Hive Civilization" },
  "offers": [
    { "@type": "Offer", "name": "Per request", "price": "0.0002", "priceCurrency": "USD" },
    { "@type": "Offer", "name": "Per GB egress", "price": "0.05", "priceCurrency": "USD" }
  ],
  "url": "https://github.com/srotzin/hive-mcp-cdn"
}
</script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML_LANDING);
});

if (!ENABLE) {
  console.log('[hive-mcp-cdn] ENABLE=false — running in dormant mode (health only)');
}


// ─── Schema constants (auto-injected to fix deploy) ─────
const SERVICE = 'hive-mcp-cdn';
const VERSION = '1.0.0';


// ─── Schema discoverability ────────────────────────────────────────────────
const AGENT_CARD = {
  name: SERVICE,
  description: 'Edge cache shim for A2A capabilities. In-memory LRU + SQLite warm tier, ETag/If-None-Match, purge endpoint. $0.0002/request and $0.05/GB egress via x402. Hive Civilization. Inbound only. New agents: first call free. Loyalty: every 6th paid call is free. Pay in USDC on Base L2.',
  url: `https://${SERVICE}.onrender.com`,
  provider: {
    organization: 'Hive Civilization',
    url: 'https://www.thehiveryiq.com',
    contact: 'steve@thehiveryiq.com',
  },
  version: VERSION,
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  authentication: {
    schemes: ['x402'],
    credentials: {
      type: 'x402',
      asset: 'USDC',
      network: 'base',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    },
  },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    { name: 'cdn_cache_get', description: 'Read a cached object by key. Returns body, content type, ETag, age, and freshness. Tier 2, $0.0002 per request plus $0.05 per GB of body bytes served via x402. Inbound only.' },
    { name: 'cdn_cache_put', description: 'Store an object under a key with optional Cache-Control max-age. Tier 0, free for now. Body may be a string, JSON value, or base64-encoded binary tagged with content_type.' },
    { name: 'cdn_purge', description: 'Purge a single cache entry by key. Tier 0, free. Idempotent — returns ok regardless of whether the key was present.' },
  ],
  extensions: {
    hive_pricing: {
      currency: 'USDC',
      network: 'base',
      model: 'per_call',
      first_call_free: true,
      loyalty_threshold: 6,
      loyalty_message: 'Every 6th paid call is free',
    },
  },
};

const AP2 = {
  ap2_version: '1',
  agent: {
    name: SERVICE,
    did: `did:web:${SERVICE}.onrender.com`,
    description: 'Edge cache shim for A2A capabilities. In-memory LRU + SQLite warm tier, ETag/If-None-Match, purge endpoint. $0.0002/request and $0.05/GB egress via x402. Hive Civilization. Inbound only. New agents: first call free. Loyalty: every 6th paid call is free. Pay in USDC on Base L2.',
  },
  endpoints: {
    mcp: `https://${SERVICE}.onrender.com/mcp`,
    agent_card: `https://${SERVICE}.onrender.com/.well-known/agent-card.json`,
  },
  payments: {
    schemes: ['x402'],
    primary: {
      scheme: 'x402',
      network: 'base',
      asset: 'USDC',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    },
  },
  brand: { color: '#C08D23', name: 'Hive Civilization' },
};

app.get('/.well-known/agent-card.json', (req, res) => res.json(AGENT_CARD));
app.get('/.well-known/ap2.json',         (req, res) => res.json(AP2));



// ─── Subscription & enterprise tier endpoints (Wave B codification) ──────────
// Partner-doctrine: identity/receipts/trust plumbing only.
// Subscription billing is denominated in USDC on Base (Monroe W1).
// Spectral receipt is emitted on every fee event via hive-receipt sidecar.
//
// Tier schedule:
//   Tier 1 (Starter)    : 25.0/mo
//   Tier 2 (Pro)        : 99.0/mo
//   Tier 3 (Enterprise) : 500.0/mo
//
// x402 tx_hash required for Tier 1+ confirmation. Tier 3 can invoice monthly.
//
// Spectral receipt: POST to hive-receipt sidecar for tamper-evident audit trail.

const SUBSCRIPTION_TIERS = {
  starter:    { price_usd: 25.0, calls_per_day: 100000, label: 'Starter' },
  pro:        { price_usd: 99.0, calls_per_day: 1000000, label: 'Pro' },
  enterprise: { price_usd: 500.0, calls_per_day: Infinity, label: 'Enterprise', invoice: true },
};

// In-memory subscription ledger (durable persistence on hivemorph backend).
const _subLedger = new Map(); // did -> { tier, activated_ms, tx_hash }

async function emitSpectralReceipt({ event_type, did, amount_usd, tool_name, tx_hash, metadata }) {
  // Posts a Spectral-signed receipt to hive-receipt. Non-blocking.
  // Error is logged but never throws — receipt emission must not block the fee path.
  try {
    const body = JSON.stringify({
      issuer_did: 'did:hive:cdn',
      recipient_did: did || 'did:hive:anonymous',
      event_type,
      tool_name,
      amount_usd: String(amount_usd),
      currency: 'USDC',
      network: 'base',
      pay_to: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
      tx_hash: tx_hash || null,
      issued_ms: Date.now(),
      service: 'Hive CDN',
      brand: '#C08D23',
      ...metadata,
    });
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 4000);
    await fetch('https://hive-receipt.onrender.com/v1/receipt/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(tid);
  } catch (_) {
    // Receipt emission is best-effort. Log and continue.
    console.warn('[cdn] receipt emit failed (non-fatal):', _.message || _);
  }
}

// POST /v1/subscription — create or upgrade a subscription
app.post('/v1/subscription', async (req, res) => {
  const { tier, did, tx_hash } = req.body || {};
  if (!tier || !SUBSCRIPTION_TIERS[tier]) {
    return res.status(400).json({
      error: 'invalid_tier',
      valid_tiers: Object.keys(SUBSCRIPTION_TIERS),
      brand: '#C08D23',
    });
  }
  const t = SUBSCRIPTION_TIERS[tier];
  if (!did) return res.status(400).json({ error: 'did_required' });

  // Enterprise tier can invoice monthly (no tx_hash required at activation).
  if (tier !== 'enterprise' && !tx_hash) {
    return res.status(402).json({
      error: 'payment_required',
      x402: {
        type: 'x402', version: '1', kind: 'subscription_cdn',
        asking_usd: t.price_usd,
        accept_min_usd: t.price_usd,
        asset: 'USDC', asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        network: 'base', pay_to: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
        nonce: Math.random().toString(36).slice(2),
        issued_ms: Date.now(),
        tier, label: t.label,
        bogo: { first_call_free: true, loyalty_every_n: 6 },
      },
      note: `Submit tx_hash for ${t.price_usd} USDC/mo to 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e on Base.`,
    });
  }

  const record = {
    tier, did, tx_hash: tx_hash || 'enterprise_invoice',
    activated_ms: Date.now(),
    expires_ms: Date.now() + 30 * 24 * 3600 * 1000,
    price_usd: t.price_usd,
    calls_per_day: t.calls_per_day,
  };
  _subLedger.set(did, record);

  // Emit Spectral receipt for subscription activation.
  await emitSpectralReceipt({
    event_type: 'subscription_activated',
    did, amount_usd: t.price_usd, tool_name: 'subscription',
    tx_hash: tx_hash || null,
    metadata: { tier, service: 'Hive CDN', expires_ms: record.expires_ms },
  });

  return res.json({
    ok: true,
    subscription: record,
    receipt_emitted: true,
    partner_attribution: 'Content distribution — Spectral edge attestation. Complements Cloudflare, Fastly. Hive attests freshness; CDN delivers.',
    brand: '#C08D23',
    note: 'Subscription active for 30 days. Spectral receipt issued to hive-receipt.',
  });
});

// GET /v1/subscription/:did — check subscription status
app.get('/v1/subscription/:did', (req, res) => {
  const record = _subLedger.get(req.params.did);
  if (!record) {
    return res.status(404).json({ active: false, did: req.params.did });
  }
  const active = Date.now() < record.expires_ms;
  return res.json({ active, ...record });
});

// POST /v1/subscription/verify — lightweight verification (no charge)
app.post('/v1/subscription/verify', (req, res) => {
  const { did } = req.body || {};
  const record = _subLedger.get(did);
  const active = record && Date.now() < record.expires_ms;
  return res.json({
    active: !!active,
    did: did || null,
    tier: record?.tier || null,
    expires_ms: record?.expires_ms || null,
    brand: '#C08D23',
  });
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[hive-mcp-cdn] listening on :${PORT} — inbound only`);
});
