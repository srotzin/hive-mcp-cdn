/**
 * x402 micropayment gate for the CDN shim.
 *
 * Two metered surfaces:
 *   - per-request    : $0.0002 / cache get
 *   - per-GB egress  : $0.05   / GB of body bytes served
 *
 * A payment buys a prepaid balance held against an access token. Reads
 * draw from the balance until it goes to zero; the next read returns a
 * 402 envelope. Validation here is mock-style and matches the house-style
 * stub used by sibling shims so the protocol surface is correct.
 */

import { randomUUID } from 'node:crypto';

const PRICE_PER_REQUEST_USD = Number(process.env.CDN_PRICE_PER_REQUEST_USD) || 0.0002;
const PRICE_PER_GB_EGRESS_USD = Number(process.env.CDN_PRICE_PER_GB_EGRESS_USD) || 0.05;
const PREPAY_BUNDLE_USD = Number(process.env.CDN_PREPAY_BUNDLE_USD) || 1.0;
const RECIPIENT = process.env.WALLET_ADDRESS || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const NONCE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 60 * 60 * 1000;

const nonces = new Map();
const tokens = new Map();

function gc() {
  const now = Date.now();
  for (const [k, v] of nonces) if (v.expires_at < now / 1000) nonces.delete(k);
  for (const [k, v] of tokens) if (v.expires_at < now) tokens.delete(k);
}
setInterval(gc, 60_000).unref?.();

export const BOGO = {
  first_call_free: true,
  loyalty_threshold: 6,
  pitch: "Pay this once, your 6th paid call is on the house. New here? Add header 'x-hive-did' to claim your first call free.",
  claim_with: 'x-hive-did header',
};

export function quoteEnvelope() {
  const nonce = randomUUID();
  const expires_at = Math.floor((Date.now() + NONCE_TTL_MS) / 1000);
  nonces.set(nonce, { expires_at, paid: false, prepay_usd: PREPAY_BUNDLE_USD });
  return {
    error: 'payment_required',
    payment: {
      nonce,
      amount_usd: PREPAY_BUNDLE_USD,
      pricing: {
        per_request_usd: PRICE_PER_REQUEST_USD,
        per_gb_egress_usd: PRICE_PER_GB_EGRESS_USD,
      },
      accepts: [{ chain: 'base', asset: 'USDC', recipient: RECIPIENT }],
      expires_at,
      tier: 2,
      product: 'cdn_prepaid_bundle',
    },
    bogo: BOGO,
  };
}

export function submitProof({ nonce, payer, chain, tx_hash } = {}) {
  if (!nonce || !payer || !chain || !tx_hash) {
    return { ok: false, status: 400, error: 'missing_fields' };
  }
  const n = nonces.get(nonce);
  if (!n) return { ok: false, status: 404, error: 'unknown_or_expired_nonce' };
  if (n.expires_at < Date.now() / 1000) {
    nonces.delete(nonce);
    return { ok: false, status: 410, error: 'nonce_expired' };
  }
  n.paid = true;
  const token = `hive_${randomUUID().replace(/-/g, '')}`;
  tokens.set(token, {
    payer,
    chain,
    tx_hash,
    balance_usd: n.prepay_usd,
    spent_usd: 0,
    requests: 0,
    bytes: 0,
    expires_at: Date.now() + TOKEN_TTL_MS,
  });
  return { ok: true, access_token: token, expires_in: Math.floor(TOKEN_TTL_MS / 1000), balance_usd: n.prepay_usd };
}

function readToken(req) {
  const hdr = req.headers['x-hive-access'];
  if (hdr && tokens.has(hdr)) {
    const t = tokens.get(hdr);
    if (t.expires_at > Date.now()) return { token: hdr, t };
    tokens.delete(hdr);
  }
  return null;
}

export function checkAccess(req) {
  if (process.env.X402_ENABLED && String(process.env.X402_ENABLED).toLowerCase() === 'false') {
    return { ok: true, bypass: 'disabled' };
  }
  const inline = req.headers['x-payment'];
  if (inline) {
    try {
      const env = typeof inline === 'string' ? JSON.parse(inline) : inline;
      if (env?.nonce && env?.payer && env?.chain && env?.tx_hash) {
        const r = submitProof(env);
        if (r.ok) return { ok: true, mint: r };
      }
    } catch { /* fall through */ }
  }
  const t = readToken(req);
  if (t && t.t.balance_usd > 0) return { ok: true, token: t.token };
  return { ok: false };
}

/**
 * Charge the token for a completed request. `bytes` should be 0 for
 * a 304 Not Modified or a miss; the per-request fee always applies.
 * Returns the residual balance for the response header.
 */
export function meter(req, { hit, bytes }) {
  const t = readToken(req);
  if (!t) return null;
  const reqCost = PRICE_PER_REQUEST_USD;
  const egressCost = bytes > 0 ? (bytes / (1024 * 1024 * 1024)) * PRICE_PER_GB_EGRESS_USD : 0;
  const total = reqCost + egressCost;
  t.t.balance_usd = Math.max(0, t.t.balance_usd - total);
  t.t.spent_usd += total;
  t.t.requests += 1;
  t.t.bytes += bytes || 0;
  return {
    token: t.token,
    spent_this_request_usd: total,
    balance_usd: t.t.balance_usd,
    requests: t.t.requests,
    bytes_served: t.t.bytes,
  };
}

export function pricing() {
  return {
    tier: 2,
    product: 'cdn',
    per_request_usd: PRICE_PER_REQUEST_USD,
    per_gb_egress_usd: PRICE_PER_GB_EGRESS_USD,
    prepay_bundle_usd: PREPAY_BUNDLE_USD,
    chain: 'base',
    asset: 'USDC',
    recipient: RECIPIENT,
    nonce_ttl_seconds: NONCE_TTL_MS / 1000,
    token_ttl_seconds: TOKEN_TTL_MS / 1000,
  };
}

export function tokenStats() {
  return { open_nonces: nonces.size, active_tokens: tokens.size };
}
