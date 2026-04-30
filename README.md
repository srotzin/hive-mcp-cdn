# hive-mcp-cdn

[![srotzin/hive-mcp-cdn MCP server](https://glama.ai/mcp/servers/srotzin/hive-mcp-cdn/badges/score.svg)](https://glama.ai/mcp/servers/srotzin/hive-mcp-cdn)

**Edge cache for A2A capabilities — Hive Civilization**

A small, inbound-only MCP server that caches arbitrary objects (agent cards, capability manifests, signed envelopes, anything an A2A pipeline reads more than once). Two-tier storage with an in-memory LRU and a SQLite warm tier, ETag and If-None-Match support, a purge endpoint, and per-request and per-GB metering through x402.

> Council provenance: Ad-hoc, user-promoted 2026-04-27.

---

## What this is

Most A2A traffic is reads — the same agent card, the same capability list, the same signed proof — fanned out across a fleet that has no shared cache. `hive-mcp-cdn` is the missing edge cache. Agents put objects under a key and fetch them back through a cheap, ETag-aware GET.

- **Protocol:** MCP 2024-11-05 over Streamable-HTTP / JSON-RPC 2.0
- **Transport:** `POST /mcp`
- **Discovery:** `GET /.well-known/mcp.json`
- **Health:** `GET /health`
- **Settlement:** USDC on Base L2
- **Brand gold:** Pantone 1245 C / `#C08D23`
- **Mode:** Inbound only. `ENABLE=true` default.

## Pricing

| Surface | Price | Charged on |
|---|---|---|
| Per request | $0.0002 USDC | Every `/v1/cdn/get`, hit or miss. |
| Per GB egress | $0.05 USDC | Body bytes returned in `200` responses. `304` responses do not bill egress. |
| Prepay bundle | $1.00 USDC | Buys an access token; reads draw from the prepaid balance until depletion. |

Settlement on Base L2 USDC. The recipient is the `WALLET_ADDRESS` env var.

## Tools

| Tool | Tier | Description |
|---|---|---|
| `cdn_cache_get` | 2 ($0.0002/req + $0.05/GB) | Read a cached object by key. Honors `if_none_match`. |
| `cdn_cache_put` | 0 (free) | Store under a key with optional `Cache-Control: max-age=...`. |
| `cdn_purge` | 0 (free) | Purge a single key. Idempotent. |

## REST endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/v1/cdn/get?key=...`     | Read. Sends `ETag`, `Cache-Control`, `X-Cache`, `Age`. Honors `If-None-Match`. |
| `POST` | `/v1/cdn/put`             | Write `{ key, body, content_type?, cache_control? }`. |
| `POST` | `/v1/cdn/purge`           | Purge `{ key }`. |
| `GET`  | `/v1/cdn/today`           | Daily counters: requests, hits, misses, bytes served, revenue. |
| `POST` | `/v1/x402/proof/submit`   | Submit on-chain proof, mint access token. |
| `GET`  | `/v1/x402/pricing`        | Pricing schedule. |
| `GET`  | `/v1/x402/stats`          | Open nonces and active tokens. |
| `GET`  | `/health`                 | Service health and cache stats. |
| `GET`  | `/.well-known/mcp.json`   | MCP discovery descriptor. |
| `GET`  | `/`                       | Landing page. |

## Storage model

Two tiers, both managed by the shim:

- **Hot (LRU):** an in-process `Map` with insertion-order recency. Bounded by `CDN_LRU_MAX_ENTRIES` and `CDN_LRU_MAX_BYTES`. Misses fall through to warm and promote on read.
- **Warm (SQLite):** `better-sqlite3` at `CDN_DB_PATH` (default `/tmp/cdn.db`). One `cache` table with body, ETag, content type, size in bytes, created and expiry timestamps. A second `egress` table aggregates daily counters.

`size_bytes` is tracked per row and is the basis for the egress meter. ETags are computed once at write time as the SHA-256 hex of the body, truncated to 32 chars and double-quoted.

## x402 flow

The first call to `/v1/cdn/get` without a token returns:

```json
{
  "error": "payment_required",
  "payment": {
    "nonce": "<uuid>",
    "amount_usd": 1.0,
    "pricing": {
      "per_request_usd": 0.0002,
      "per_gb_egress_usd": 0.05
    },
    "accepts": [{ "chain": "base", "asset": "USDC", "recipient": "0x15184b..." }],
    "expires_at": 1777220000,
    "tier": 2,
    "product": "cdn_prepaid_bundle"
  }
}
```

Submit proof to `/v1/x402/proof/submit`:

```json
{ "nonce": "...", "payer": "0x...", "chain": "base", "tx_hash": "0x..." }
```

…then call `/v1/cdn/get` with `X-Hive-Access: hive_<token>`. Each request decrements the prepaid balance by `per_request + (bytes / 1GB) * per_gb_egress`. The residual balance rides the `X-Hive-Balance-USD` response header.

## Cache semantics

- `Cache-Control: max-age=<s>` on `PUT` sets the TTL. Default `300` seconds. Capped at 7 days.
- ETag is a strong validator (SHA-256 prefix in quotes).
- `If-None-Match: <etag>` on `GET` returns `304 Not Modified` with no body and no egress charge.
- Expired entries are dropped lazily on read and on a 60-second sweep.
- A `PUT` over an existing key replaces the body, ETag, content type, TTL, and resets the hit counter.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `ENABLE` | `true` | Master switch. `false` runs `/health` only. |
| `WALLET_ADDRESS` | `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e` | Recipient for x402 fees. |
| `CDN_PRICE_PER_REQUEST_USD` | `0.0002` | Per-request fee. |
| `CDN_PRICE_PER_GB_EGRESS_USD` | `0.05` | Per-GB egress fee. |
| `CDN_PREPAY_BUNDLE_USD` | `1.0` | Default prepay bundle size. |
| `CDN_DEFAULT_TTL_S` | `300` | Default TTL for objects without explicit `max-age`. |
| `CDN_LRU_MAX_ENTRIES` | `1024` | Hot-tier entry cap. |
| `CDN_LRU_MAX_BYTES` | `67108864` | Hot-tier byte cap (64 MiB). |
| `CDN_MAX_OBJECT_BYTES` | `4194304` | Per-object size limit (4 MiB). |
| `CDN_DB_PATH` | `/tmp/cdn.db` | SQLite warm-tier path. |

## What this server will not do

- Make outbound requests of any kind. The cache only holds what was put into it.
- Resolve URLs, fetch origins, or revalidate against a backing store.
- Enforce per-key access control. Treat keys as opaque namespaces and gate them upstream if you need privacy.
- Persist beyond the SQLite file. On a fresh container with a new `/tmp`, the cache is empty.

## License

MIT.

<!-- HIVE-GAMIFICATION-META-START -->
## Hive Gamification

This MCP server is part of the Hive Civilization gamification surface (10-mechanic capability taxonomy).

- Capability taxonomy: https://hive-gamification.onrender.com/.well-known/hive-gamification.json
- Centrifuge dashboard: https://hive-gamification.onrender.com/.well-known/hive-centrifuge.json
- Consolidated OpenAPI: https://hive-gamification.onrender.com/.well-known/openapi.json

**Surface tags:** `gamification.spec.v1` · `gamification.surface.public` · `gamification.signal.read-only` · `gamification.settlement.real-rails`

Real rails on Base L2 (USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). Read-only signal layer. Brand gold `#C08D23`.
<!-- HIVE-GAMIFICATION-META-END -->

## Hive Civilization Directory

Part of the Hive Civilization — agent-native financial infrastructure.

- Endpoint Directory: https://thehiveryiq.com
- Live Leaderboard: https://hive-a2amev.onrender.com/leaderboard
- Revenue Dashboard: https://hivemine-dashboard.onrender.com
- Other MCP Servers: https://github.com/srotzin?tab=repositories&q=hive-mcp

Brand: #C08D23
<!-- /hive-footer -->
