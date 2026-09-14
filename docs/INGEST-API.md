# dsh-cost-cloud Ingest API contract (v1 / `syncVer = 1`)

This document is the **authoritative reference for adapter authors**. Any agent (DSH / ZCode / Codex / Claude Code / your own tool) can implement an adapter against this contract and have its token usage and cost aggregated by this service and shown in the admin dashboard — including the **Device × Agent** matrix view.

This file mirrors the implementation: the server has contract tests (`test/contract.test.js`) that fail if the behaviour promised here drifts from the code.

- Machine-readable contract: `GET /api/v1/protocol`
- Capability negotiation: `GET /api/v1/health`
- Runnable examples: `docs/examples/curl.sh`, `docs/examples/minimal-adapter.mjs`
- Self-check: `docs/examples/conformance.mjs` (idempotency, error codes, watermark, attribution)
- Fuller prose (Chinese): [`INGEST-API.zh.md`](./INGEST-API.zh.md)

---

## 1. Identity model

| Concept | Meaning | Produced by |
|---|---|---|
| `machineId` | **Machine-level identity.** Every agent on the same machine MUST use the same `machineId`. | Shared file `~/.dsh-cost/device.json` |
| `deviceId` | Server-side device key. Defaults to `machineId`. | Client (server records it) |
| `deviceName` | Display name; the user renames it in the DSH plugin settings card. | Client value is only a *suggestion* |
| `source` | **Agent identifier** (`dsh` / `zcode` / `codex` / `claude-code` / custom). | Fixed by the adapter |
| `agentInstance` | Distinguishes multiple instances of the same agent on one machine (extra profiles/installs). Optional. | Adapter |
| `token` | Ingest credential, one per device (or per source). | Created in the admin UI, or self-registered |

> ⚠️ **Most common failure**: each adapter generates its own `machineId`, so "one laptop + two agents" appears as **two devices**. Share `~/.dsh-cost/device.json` (override the directory with `DSH_COST_HOME` to merge multiple OS users into one device).

Statistics are keyed by `(deviceId, source, agentInstance)`, so per-device and per-agent usage/cost can be viewed, filtered and exported independently — and row totals, column totals and the grand total always agree.

### `source` naming
- Lowercase letters, digits, hyphens: `^[a-z0-9][a-z0-9-]{0,31}$`
- Stable and never reused; do not embed versions or hostnames
- Suggested: `dsh`, `zcode`, `codex`, `claude-code`, `gemini-cli`, `kimi-cli`

---

## 2. Transport

```
Authorization: Bearer <token>
Content-Type: application/json
X-Device-Id: <machineId>      # optional; a body `deviceId` wins
X-Source: <source>            # optional; a body `source` wins
```

- Tokens look like `dshc_<43 base64url chars>`; the plaintext is returned **once** at registration. Only a hash is stored — rotate in the admin UI if lost.
- Request body ≤ **4 MB**, `records` ≤ **2000** entries per batch. All responses are JSON.
- **Unknown fields are tolerated** (ignored or stored in `meta`), so adapters may ship ahead of the server.
- All timestamps are **epoch milliseconds** (integers). Day/month bucketing is fixed to **Beijing time (UTC+8)**, matching the DSH plugin's `dayKey()`.

---

## 3. Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/health` | Health + capability negotiation (no auth) |
| GET | `/api/v1/protocol` | Machine-readable contract (no auth) |
| POST | `/api/v1/devices/register` | Register device, receive token (requires `ALLOW_DEVICE_SELF_REGISTER=1`, else `403`) |
| POST | `/api/v1/ingest/records` | Ingest detail records (optionally with rollup snapshots) |
| POST | `/api/v1/ingest/rollups` | Ingest rollup snapshots only (full re-send) |
| POST | `/api/v1/ingest/tombstone` | Declare deleted records so the server excludes them |
| GET | `/api/v1/ingest/watermark` | Read the highest accepted `seq` |
| POST | `/api/v1/ingest/heartbeat` | Liveness / token check |

### 3.1 `GET /api/v1/health`

```json
{
  "ok": true, "serviceVersion": "1.0.0", "syncVer": 1, "minSyncVer": 1,
  "time": 1789392645019,
  "caps": {
    "rollups": true, "tombstones": true, "meta": true, "heartbeat": true, "selfRegister": false,
    "maxBatchRecords": 2000, "maxBodyBytes": 4194304,
    "groupBy": ["device", "source", "agentInstance", "model", "project", "day", "provider"]
  }
}
```
Adapters should: stop and ask the user to upgrade the server if `syncVer !== 1`; stop if their own version `< minSyncVer`; never call register when `caps.selfRegister` is false.

### 3.2 `POST /api/v1/devices/register`

```json
// request
{ "deviceId": "6f1c…", "deviceName": "Studio Desktop", "source": "dsh", "agentInstance": "" }
// 200
{ "ok": true, "deviceId": "6f1c…", "token": "dshc_…", "deviceName": "Studio Desktop" }
```
Registering the same `deviceId` again returns a *new* token; existing tokens stay valid (rotate in the admin UI to revoke).

### 3.3 `POST /api/v1/ingest/records`

```json
{
  "syncVer": 1,
  "source": "dsh",
  "agentInstance": "",
  "agent": { "name": "DSH", "version": "0.1.0-rc.9", "pluginVersion": "1.8.0" },
  "deviceId": "6f1c…",
  "deviceName": "Studio Desktop",
  "resetEpoch": 0,
  "maxClientSeq": 1383,
  "sentAt": 1789392645019,
  "clock": { "tzOffset": -480 },
  "batchUid": "3f2b0c8e-…",
  "records": [{
    "seq": 1384, "ts": 1789392645019,
    "provider": "deepseek-official", "model": "deepseek-v4.1-flash",
    "sessionId": "session-ddb21caa-…", "purpose": "",
    "tokens": { "input": 3850, "output": 2880, "cacheRead": 43904, "cacheWrite": 0, "reasoning": 2612 },
    "cost": 0.01624808, "costBasis": "reported", "estimated": false,
    "period": "off-peak", "subscription": false,
    "meta": { "workspace": "proj-a" }
  }],
  "rollups": [{
    "dayKey": "2026-03-04", "provider": "deepseek-official", "model": "deepseek-v4.1-flash",
    "subscription": false, "calls": 12,
    "tokens": { "input": 12000, "output": 8000, "cacheRead": 40000, "cacheWrite": 0, "reasoning": 0 },
    "cost": 1.23, "peak": 0.4, "off": 0.8, "flat": 0.03,
    "absorbed": ["<dedupKey>", "…"]
  }]
}
```

```json
// 200
{ "ok": true, "accepted": 12, "updated": 0, "duplicates": 3, "invalid": 0,
  "tombstoned": 0, "rollupsUpserted": 1,
  "cost": { "computed": 0.195, "deviceReported": 0.195, "drift": 0, "basis": "reported" },
  "watermark": { "maxClientSeq": 1384, "lastAcceptedAt": 1789392645100 },
  "warnings": [] }
```

- **Idempotent**: replaying the same `batchUid` returns the first outcome and counts nothing twice.
- `accepted` = rows inserted; `updated` = existing rows whose display fields were refreshed (e.g. recomputed cost); `duplicates` = byte-identical, nothing changed; `invalid` = skipped records (see `warnings`).
- `tombstoned` = previously reported details excluded because a rollup snapshot absorbed them (they are counted by the snapshot instead).

### 3.4 `POST /api/v1/ingest/rollups`
Same envelope as 3.3 with `snapshots` instead of `records`.

### 3.5 `POST /api/v1/ingest/tombstone`
```json
{ "syncVer": 1, "source": "dsh", "deviceId": "6f1c…", "reason": "user-reset", "keys": ["<dedupKey>"] }
```
Marks records as deleted (excluded from all aggregates). Rows are not physically removed; the admin UI can purge.

### 3.6 `GET /api/v1/ingest/watermark?source=&agentInstance=`
```json
{ "ok": true, "maxClientSeq": 1384, "lastAcceptedAt": 1789392645100 }
```
Device comes from the token; override with `?deviceId=`.

---

## 4. Field reference

### 4.1 Envelope

| Field | Type | Required | Notes |
|---|---|---|---|
| `syncVer` | integer | ✅ | must be `1` |
| `source` | string | ✅ | missing → `400 MISSING_SOURCE` |
| `agentInstance` | string | ❌ | default `""` |
| `agent` | object | ❌ | `{name, version, pluginVersion}`, display only |
| `deviceId` | string | ❌ | defaults to the token's device; pass your `machineId` |
| `deviceName` | string | ❌ | suggestion; a user rename in the admin UI wins |
| `resetEpoch` | integer | ❌ | increments when local data is wiped (see §6) |
| `maxClientSeq` | integer | ❌ | highest `seq` in this batch |
| `sentAt` | integer | ❌ | diagnostics only |
| `clock` | object | ❌ | `{tzOffset}` in minutes, recorded but not used for bucketing |
| `batchUid` | string | ❌ | idempotency key; generate a UUID per request |
| `records` | array | ❌ | detail rows (`records` or `rollups` required) |
| `rollups` | array | ❌ | daily snapshots |

### 4.2 Detail record

| Field | Type | Required | Notes |
|---|---|---|---|
| `seq` | integer | ❌ | adapter-local monotonic counter (recommended; drives the watermark) |
| `ts` | integer | ✅ | call time, epoch ms |
| `provider` | string | ✅ | e.g. `deepseek-official`, `moonshot-ai` |
| `model` | string | ✅ | **billed** model name (for routed requests use the effective one) |
| `tokens` | object | ✅ | see 4.3 |
| `sessionId` | string | ❌ | sensitive; hash it if needed (§7) |
| `purpose` | string | ❌ | project/attribution label |
| `cost` | number | ❌ | adapter-computed CNY; the server treats this as a reference, not the authority |
| `costBasis` | enum | ❌ | `reported` / `estimated` / `subscription` / `unknown` |
| `estimated` | boolean | ❌ | |
| `subscription` | boolean | ❌ | covered by a subscription plan (equivalent cost) |
| `period` | enum | ❌ | `peak` / `off-peak` / `flat` (server recomputes from `ts`) |
| `meta` | object | ❌ | adapter-specific, stored verbatim (≤1 KB/row) |

### 4.3 `tokens`

| Field | Type | Required | Notes |
|---|---|---|---|
| `input` | integer | ✅ | input tokens **that missed the cache** |
| `output` | integer | ✅ | |
| `cacheRead` | integer | ❌ | cache **hit/read** input tokens (default 0) |
| `cacheWrite` | integer | ❌ | cache **write/creation** input tokens (default 0) |
| `reasoning` | integer | ❌ | reasoning tokens when billed separately (default 0) |

**Naming map**

| Common name | Map to |
|---|---|
| `prompt_tokens` / `input_tokens` / `inputTokens` | `input` (**after subtracting cache hits**) |
| `completion_tokens` / `output_tokens` | `output` |
| `cached_tokens` / `cached_input_tokens` / `cache_read_input_tokens` / `prompt_cache_hit_tokens` | `cacheRead` |
| `cache_creation_input_tokens` / `cache_write_tokens` | `cacheWrite` |
| `reasoning_tokens` / `thinking_tokens` | `reasoning` |

> ⚠️ Never put the full `prompt_tokens` into `input` when the provider includes cache hits in it: `input = prompt_tokens - cached_tokens`, otherwise input cost is heavily overstated.

### 4.4 Rollup snapshot

| Field | Type | Required | Notes |
|---|---|---|---|
| `dayKey` | string | ✅ | Beijing-time `YYYY-MM-DD` |
| `provider` / `model` | string | ✅ | |
| `subscription` | boolean | ✅ | keeps metered and subscription figures separate |
| `calls` | integer | ✅ | |
| `tokens` | object | ✅ | daily totals, same shape as 4.3 |
| `cost` | number | ✅ | daily total cost |
| `peak` / `off` / `flat` | number | ❌ | segment costs (default: all in `flat`) |
| `absorbed` | string[] | ❌ | `dedupKey`s of details folded into this snapshot |

Details are pruned locally (DSH keeps 180 days) and folded into rollups. If those details were already ingested, list their `dedupKey`s in `absorbed`. The server turns every listed key into a **tombstone**, permanently excluding that detail from all aggregates — **even if the detail has not arrived yet** (so out-of-order arrivals lose nothing: the late detail is recognised as already covered by the snapshot, kept only for audit, and never double-counted). Always send **details before snapshots**.

---

## 5. Error codes

| HTTP | `code` | Meaning | Adapter action |
|---|---|---|---|
| 400 | `MISSING_SOURCE` | `source` absent | fix the adapter (do not retry) |
| 400 | `UNSUPPORTED_SYNC_VER` | version rejected (response carries `minSyncVer`/`syncVer`) | tell the user to upgrade, stop |
| 400 | `INVALID_BODY` | JSON parse failure | fix the adapter |
| 400 | `INVALID_RECORD` | a record failed validation | inspect `warnings`, skip that row |
| 401 | `TOKEN_INVALID` | token unknown or rotated | stop, ask the user to reconfigure |
| 401 | `TOKEN_MISSING` | no `Authorization` header | fix the adapter |
| 403 | `DEVICE_DISABLED` | device disabled by the admin | stop |
| 403 | `SELF_REGISTER_DISABLED` | self-registration off | create a token in the admin UI |
| 404 | `UNKNOWN_ROUTE` | wrong path | check the base URL |
| 413 | `PAYLOAD_TOO_LARGE` | body > 4 MB | shrink the batch and retry |
| 429 | `RATE_LIMITED` | throttled (response carries `retryAfterMs`) | back off by `retryAfterMs` |
| 500 | `INTERNAL` | server error | exponential backoff 5s → 10s → … → 300s |

```json
{ "ok": false, "code": "TOKEN_INVALID", "error": "human readable", "retryAfterMs": 0 }
```

---

## 6. Deduplication (implement exactly)

### 6.1 Normalisation

1. **Strings**: `String(v)` → trim; `provider` and `model` lowercased. Missing → `""`.
2. **Integers**: `Math.trunc(Number(v))`; non-finite → `0`.
3. **Cost**: round to **6 decimals**, then emit the *shortest* decimal form: `0`, `0.016248`, `1.5`, `123.456789`. Java's `Double.toString`, Go's `strconv.FormatFloat(v,'f',-1,64)` and Rust's `{}` for `f64` all match; do **not** use fixed-width formatting.
4. **Canonical string**: join the fields below in this exact order with `\u001f` (Unit Separator) — **not JSON**:
   ```
   <mode> ␟ <resetEpoch> ␟ <ts> ␟ <provider> ␟ <model> ␟ <sessionId> ␟ <purpose>
         ␟ <input> ␟ <output> ␟ <cacheRead> ␟ <cacheWrite> ␟ <reasoning> ␟ <cost6>
   ```
   - detail: `mode = "detail"`
   - rollup: `mode = "rollup:<dayKey>"`, concatenating **only** `subscription`, `provider`, `model`
     (i.e. `rollup:<dayKey> ␟ <0|1> ␟ <provider> ␟ <model>`).
     ⚠️ A snapshot's **mutable metrics** (`calls`/`tokens`/`cost`) are **not part of its identity**: the snapshot grows as the day continues, and keying on metrics would insert a new row on every growth and double-count. The server merges rows with the same key monotonically via `max()`.
5. **`dedupKey`** = lowercase hex **SHA-256** of that string.

`resetEpoch` participates, so data re-imported after a local wipe is not mistaken for duplicates.

### 6.2 JavaScript reference

```js
import { createHash } from 'node:crypto'
const US = '\u001f'
const s = (v) => (v == null ? '' : String(v).trim())
const i = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0 }
function cost6(v) { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : '0' }

export function detailCanonical(r, { resetEpoch = 0 } = {}) {
  const t = r.tokens || {}
  return ['detail', i(resetEpoch), i(r.ts), s(r.provider).toLowerCase(), s(r.model).toLowerCase(),
    s(r.sessionId), s(r.purpose), i(t.input), i(t.output), i(t.cacheRead), i(t.cacheWrite),
    i(t.reasoning), cost6(r.cost)].join(US)
}
export const sha256hex = (str) => createHash('sha256').update(str, 'utf8').digest('hex')
```

Test vector (also checked by `conformance.mjs`):

| Input | Expected canonical |
|---|---|
| `{ts:1789392645019, provider:'DeepSeek-Official', model:'DeepSeek-V4.1-Flash', sessionId:' s1 ', purpose:null, tokens:{input:3850,output:2880,cacheRead:43904}, cost:0.01624808}`, `resetEpoch:0` | `detail␟0␟1789392645019␟deepseek-official␟deepseek-v4.1-flash␟s1␟␟3850␟2880␟43904␟0␟0␟0.016248` |

---

## 7. Privacy

- Only token counts, costs, timestamps and identifiers — **never** prompts, responses, file paths or code.
- Prefer hashing `sessionId`: `sha256(sessionId).slice(0, 16)` (stable per session, not reversible). The DSH plugin exposes a "mask session id" switch.
- Replace sensitive `purpose` values with codes before sending.
- Use HTTPS in production.
- `meta` is stored verbatim: never put credentials in it.

---

## 8. Incremental sync and retries

1. Keep the server watermark (`maxClientSeq`) and send only `seq > watermark`.
2. The watermark is a bandwidth optimisation only — §6 dedup makes a full re-send safe.
3. Cap the first backfill with `syncSinceDays` (DSH defaults to 180 days).
4. Batches: ≤ 2000 records, ≤ 4 MB; 500 per batch is a good default.
5. Backoff: honour `retryAfterMs` for 429; exponential for 5xx; never retry 401/403.
6. Details before snapshots; never send an `absorbed` snapshot before its details.
7. Upload failures must never break local accounting: persist locally first, upload asynchronously.

---

## 9. Versioning

- `syncVer` increments on breaking changes; `/health` publishes `syncVer` and `minSyncVer`.
- New optional fields do not bump `syncVer`.
- Deprecation: served with `warnings` for one release, rejected afterwards.
- Adapters should call `/health` once at startup and cache the result for ~5 minutes.

---

## 10. Anti-patterns (from real incidents)

| Anti-pattern | Effect | Fix |
|---|---|---|
| One `machineId` per agent | one computer counted as N devices | share `~/.dsh-cost/device.json` |
| Cache hits inside `input` | input cost overstated 2–10× | `input = prompt_tokens - cached_tokens` |
| Reporting cumulative counters | usage inflates with every replay | report **deltas** |
| The same physical call counted by two agents (e.g. parent and bundled sub-agent) | double counting | decide ownership in the adapter; only the layer that actually pays should record |
| `JSON.stringify` for the dedup key | cross-language mismatch → duplicates | use the canonical string in §6 |
| Snapshot without `absorbed` | overlaps live details → double counting | declare absorbed `dedupKey`s |
