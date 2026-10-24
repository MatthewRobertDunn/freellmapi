# AGENTS.md — Adding models to this FreeLLMAPI install

This checkout (`/home/matty/freellmapi`, branch `matty`) is a source install of
FreeLLMAPI that runs as a **systemd user service** in **production mode**. This
document explains how to add or change models here using the **declarative
startup config**, which is how this install manages its model list.

## How this install runs

| Thing | Value |
|---|---|
| Working dir | `/home/matty/freellmapi` |
| Service | `freellmapi.service` (systemd **user** unit) |
| Mode | `NODE_ENV=production`, runs the built server: `node server/dist/index.js` |
| Runtime config | `/home/matty/freellmapi/.env` (secrets + startup env) |
| Declarative config | `/home/matty/freellmapi/freellmapi.config.json` |
| Database | `/home/matty/freellmapi/server/data/freeapi.db` |
| Logs | `journalctl --user-unit freellmapi.service` |

> Because this is production mode, the server **auto-runs DB migrations at
> startup**. Do not run `npm run db:migration:up` against this database; that
> path is for `NODE_ENV=development` only.

## TL;DR — add a model

1. Add an entry to the `models` array in `freellmapi.config.json`.
2. Restart the service: `systemctl --user restart freellmapi.service`
3. Verify (see [Apply & verify](#apply--verify)).

That is the whole loop. There is no hot reload; the config is read once per boot.

## Dashboard / API credentials

Local-only credentials (dashboard email/password, a session token, and the proxy
key) live in **`CREDENTIALS.local.md`** — it is **gitignored** (`*.local.md`), so
it never lands in a commit. Read it for the current values and for copy-paste
recipes: logging in to mint a dashboard bearer token, calling `/api/models`
(list / add / edit / **test** / delete), and testing inference through `/v1`
including a forced tool-call check.

Two credentials, don't mix them up:

- **Dashboard session token** → `Authorization: Bearer <token>` (or
  `x-dashboard-token:`) authorizes **`/api/*`** (models, keys, fallback, …).
  Mint it via `POST /api/auth/login`; it can expire.
- **Proxy key** (`freellmapi-…`) authorizes **`/v1/*`** only — never `/api/*`.

## How the declarative config is wired

`server/src/index.ts` calls `applyDeclarativeConfigFromEnv()` in `main()`,
**after `initDb()` and before the HTTP listener starts** (`NODE_ENV=production`,
so migrations are already applied). The implementation lives in
`server/src/services/declarative-config.ts`.

It is wired up through `.env`:

```env
FREEAPI_CONFIG_PATH=/home/matty/freellmapi/freellmapi.config.json
```

Precedence and shape:

- `FREEAPI_CONFIG_JSON` (inline JSON) wins over `FREEAPI_CONFIG_PATH` if both
  are set. Keep the file and use `FREEAPI_CONFIG_PATH` here.
- The **top level is strict** — only these keys are accepted:
  `admin`, `license`, `keys`, `customProviders`, `models`, `fallback`,
  `routing`. An unknown top-level key fails the whole apply.
- The config is applied inside a DB transaction and is **idempotent**: existing
  keys, models, fallback rows and routing settings are updated in place, never
  duplicated. Re-running a restart with the same file is safe.

## The `models` entry

A `models` entry adds a model or edits one that already exists.

| Field | Type | Meaning |
|---|---|---|
| `platform` | string, **required** | Provider slug, e.g. `nvidia`. Must match a registered provider (see below) for the model to route. |
| `modelId` | string, **required** | The provider's exact model id, e.g. `z-ai/glm-5.3`. |
| `displayName` | string | Friendly label shown in the dashboard. Defaults to `modelId`. |
| `intelligenceRank` | int 1–1000 | Lower = smarter (the router orders `intelligence_rank ASC`). Frontier models are ~1–40. |
| `speedRank` | int | Lower = faster. The catalog uses 1–10 (`1 = fastest`). |
| `sizeLabel` | string ≤ 40 | Capability tier: `Small` / `Medium` / `Large` / `Frontier`. Tier dominates the intelligence score. |
| `contextWindow` | int / null | Context window in tokens. |
| `supportsVision` | bool | Set only if the provider documents vision support. |
| `supportsTools` | bool | Set only if the provider documents tool/function-calling support. |
| `rpmLimit` / `rpdLimit` / `tpmLimit` / `tpdLimit` | int / null | Per-key rate limits. |
| `monthlyTokenBudget` | string ≤ 80 | Free-form display string, e.g. `~2M (credits)`. |
| `enabled` | bool | Default `true`. `false` keeps the row but stops it being routed. |
| `fallbackEnabled` | bool | Default `true`. `false` keeps the model out of the fallback chain. |
| `endpoint` | string | Only for `custom` providers, to disambiguate relays (see below). |

### What an entry actually does

- **New `(platform, modelId)`** → inserted with `source = 'user'`. Catalog sync
  will never update or prune a user-owned row, so it survives catalog refreshes.
- **Existing row** (e.g. a model that already arrived from the catalog) → the
  row is patched, and for catalog-managed rows an **override** is recorded so the
  change is not clobbered by the next sync.
- Either way the entry also ensures a `fallback_config` row and a `profile_models`
  entry, so a newly declared model is immediately routable.

Only set capability fields (`supportsTools`, `supportsVision`, ranks, context
window) to values you can back up. Per this repo's `CONTRIBUTING.md`: **no
invented facts** — model ids, limits and endpoints must be verified against the
provider, not recalled. Leaving a field out is honest ("unknown"), whereas a
wrong value ships a bug.

### Minimal vs. full entry

Minimal (recommended when you don't have verified metadata):

```json
{ "platform": "nvidia", "modelId": "z-ai/glm-5.3", "displayName": "GLM 5.3 (NV)" }
```

Full:

```json
{
  "platform": "nvidia",
  "modelId": "z-ai/glm-5.3",
  "displayName": "GLM 5.3 (NV)",
  "intelligenceRank": 20,
  "speedRank": 5,
  "sizeLabel": "Frontier",
  "contextWindow": 131072,
  "supportsTools": true,
  "fallbackEnabled": true
}
```

## Finding the platform slug

Slugs are the `platform:` values registered in
`server/src/providers/index.ts` (e.g. `nvidia` → NVIDIA NIM,
`openrouter`, `groq`, `custom`). A model can only route if its `platform`
matches a registered provider; a typo silently produces an unroutable row.

## Fallback order and routing

To control order, use the top-level `fallback` and `routing` keys:

```json
{
  "models": [ { "platform": "nvidia", "modelId": "z-ai/glm-5.3" } ],
  "fallback": [ { "platform": "nvidia", "modelId": "z-ai/glm-5.3", "priority": 1 } ],
  "routing": { "strategy": "balanced" }
}
```

`priority` defaults to the array index. `strategy` is one of `priority`,
`balanced`, `smartest`, `fastest`, `reliable`, `custom`.

## Pinning one provider's copy of a model

With unify ON, one logical name (e.g. `glm-5.3-flash`) can cover several
providers' rows, and a bare `id` in a request resolves to the whole group — the
router then picks the best available member and may fail over to another
provider. To target **one** provider's copy (no failover to the rest of the
group), send the model as:

```
platform:model_id
```

For example, `orcarouter:z-ai/glm-5.3-flash-free` forces the OrcaRouter row even
though NVIDIA also serves a `z-ai/glm-5.3-flash` copy that the bare
`z-ai/glm-5.3-flash-free` name can otherwise resolve to. `memberId(row)` is
`` `${row.platform}:${row.model_id}` `` (`server/src/services/model-groups.ts`,
`resolveRequestedIdToTieredMembers`); this exact match is checked before the bare
`model_id` scan, so a platform prefix always wins. Note the separator is a
**colon** — `orcarouter/...` (slash) is treated as a literal model id and 404s.

This works only when unify is enabled. For `custom` relays that share a model id,
append an endpoint instead: `custom:model_id#<endpoint-handle-or-url>`.

## Providers that need a key

Adding a model does **not** add credentials. NVIDIA NIM (and most providers)
need an API key before the model can serve requests. Provide it either in the
dashboard (Keys page) or declaratively:

```json
{ "keys": [ { "platform": "nvidia", "key": "nvapi-...", "label": "main" } ] }
```

A `keys` entry carries a plaintext secret, so keep secrets out of a file you
share, and remember `.env`/the config file are protected only by filesystem
permissions.

## Applying & verifying

```bash
# 1. Validate the JSON is at least well-formed
node -e 'JSON.parse(require("fs").readFileSync("freellmapi.config.json","utf8"))'

# 2. Apply (config is read on boot)
systemctl --user restart freellmapi.service

# 3. Confirm the apply ran and how many edits it made
journalctl --user-unit freellmapi.service --no-pager | grep '\[config\] applied'

# 4. Confirm the rows exist in the DB
node -e 'const D=require("better-sqlite3");
const db=new D("server/data/freeapi.db",{readonly:true});
console.table(db.prepare(
  "SELECT platform,model_id,display_name,source,enabled FROM models WHERE platform=?"
).all("nvidia"));'
```

A healthy apply logs something like:

```
[config] applied /home/matty/freellmapi/freellmapi.config.json: 0 keys, 0 custom models, 6 model edits, 6 fallback rows
```

Per-entry problems are reported as warnings and **skipped**, not fatal — read the
count and the `entries skipped` suffix, and grep for `[config]` warnings.

## Testing NIM directly (backend, no router)

Sometimes you want to test the NVIDIA NIM backend itself, bypassing the router.
The NIM key (`nvapi-…`) lives in `CREDENTIALS.local.md` (gitignored) along with
the dashboard/proxy credentials. The backend base URL is
`https://integrate.api.nvidia.com/v1/` (the same OpenAI-compatible API the
`nvidia` provider wraps).

Quick chat test (grab the key from `CREDENTIALS.local.md`; never hardcode it
into committed files):

```bash
export NIM_API_KEY='<nvapi key from CREDENTIALS.local.md>'
curl -s https://integrate.api.nvidia.com/v1/chat/completions \
  -H "Authorization: Bearer $NIM_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"minimaxai/minimax-m3.1-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

### Measuring a model's real context length

`scripts/probe-context-length.mjs` binary-searches token counts until the
provider rejects with a context-length error. It reads the true token count
from `usage.prompt_tokens`, parses NVIDIA's exact limit out of the error body
(`details.limit`), and backs off on 429s (throttling is not a context failure):

```bash
NIM_API_KEY=$NIM_API_KEY node scripts/probe-context-length.mjs minimaxai/minimax-m3.1-flash
# options: --base <url> --max-tokens 16 --hi <upper-bound-guess> --tries 16 --timeout 120000
# usage for repetition: `curl -s -H "Authorization: Bearer $NIM_API_KEY" ...`
```

It prints the provider-stated limit (authoritative when given), the largest
measured `usage.prompt_tokens` success, and the full probe trail. NIM's
context errors look like
`{"details":{"type":"context_length","limit":262144,"actual":315564}}` — the
limit counts input **and** output tokens together. Verified 2026-10-24:
`minimaxai/minimax-m3.1-flash` really does serve up to 262144 (largest measured
success was ~201.8k input tokens + 16 output; throttle your probe pace — the
account hits token-per-minute 429s quickly at these sizes).

## Custom (non-catalog) endpoints

For an OpenAI-compatible endpoint that is not a registered provider, declare it
under `customProviders` (with `baseUrl`, optional `apiKey`, `label`, and its
`models`), then reference those models from `models`/`fallback` with
`"platform": "custom"`. When two endpoints serve the same model id, add
`"endpoint"` (the URL or its short handle) so the entry is unambiguous.

## Deleting a model

Deleting a model removes the row **and writes a tombstone**, so the next catalog
sync cannot resurrect it. This is different from disabling:

| Action | `/v1/models` | Routing |
|---|---|---|
| Disable (`enabled: false`) | Still listed, tagged `available: false` | Stopped |
| Delete | **Gone from the list** | Gone |

Do NOT delete by writing to the DB by hand — bypassing the API skips the
tombstone and cleanup side effects; the row would simply return on the next
catalog sync. Instead:

1. **Get a dashboard token.** The proxy key (`freellmapi-…`) only authorizes
   `/v1/*`; the dashboard/admin API needs a session token from browser login.
2. **Find the row's integer id** (one row per provider per model — a model served
   by three relays has three rows; deleting one leaves the others):

   ```bash
   curl -s -H "Authorization: Bearer <dashboard token>" \
     http://192.168.0.2:3001/api/models | \
     node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const r of JSON.parse(d)) console.log(r.id, r.platform, r.modelId)})'
   ```

3. **Delete by id** (also use it per-id for every provider copy you want gone):

   ```bash
   curl -s -X DELETE -H "Authorization: Bearer <dashboard token>" \
     http://192.168.0.2:3001/api/models/<id>
   # → {"success":true,...}; a second call returns 404 once the row is gone
   ```

4. **Verify:**

   ```bash
   curl -s -H "Authorization: Bearer <dashboard token>" http://192.168.0.2:3001/api/models | \
     node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log("left:",(Array.isArray(j)?j:[]).length)})'
   node -e 'const D=require("better-sqlite3");
   const db=new D("server/data/freeapi.db",{readonly:true});
   console.table(db.prepare("SELECT kind,platform,model_id,source FROM catalog_model_tombstones ORDER BY created_at DESC LIMIT 5").all());'
   ```

Deletion inside the route (`server/src/routes/models.ts`, `modelsRouter.delete('/:id')`)
records a `catalog_model_tombstones` row with `source='user'`, clears
`profile_models`/`fallback_config` entries, and deletes the `models` row in one
transaction. For custom-relay models (`platform='custom'`) it also runs
`deleteUnusedCustomEndpointKey`. Upstream EOL retirements use
`source='upstream_eol'` instead and keep the row disabled; those can be
reinstated by a later catalog, a user tombstone cannot (only by re-adding the
model).

## Gotchas

- **Deleting a unified-group member affects the group.** With unify ON,
  `/v1/models` shows one entry per logical model; deleting a member row drops
  that provider copy (merge membership, fallback and profile state) but not the
  other providers' rows.
- **Deletions survive restarts and catalog syncs** — a deleted model has a
  `source='user'` tombstone that catalog sync honors permanently. The only thing
  that clears the tombstone is *declaring the model again* in
  `freellmapi.config.json` (`declarative-config.ts`, `upsertModel()` — a
  declaration is treated as operator intent to restore). So on restart, only
  models actually declared in the config reappear; never delete a model that is
  still declared there without first removing its declarative entry. (The file
  cannot be used to delete; it only adds or edits.)

- **`ENCRYPTION_KEY` must stay stable.** Provider keys are encrypted at rest with
  it; changing it breaks every stored secret. It lives in `.env` (mode `600`).
- **No hot reload** — always restart the service after editing the config.
- **Do not rebuild for config-only changes.** `freellmapi.config.json` and
  `.env` are read at runtime. A `npm run build` is only needed after editing
  TypeScript under `server/`, `client/`, `shared/` or `cli/`.
- **Binding:** the server listens on `HOST` from `.env` (currently
  `192.168.0.2`), not loopback, so the first-run setup code is required from any
  browser. Find it with
  `journalctl --user-unit freellmapi.service | grep 'setup code' | tail -1`.
- **OrcaRouter free models are account-gated.** A 429 saying "Free models are
  not available to this account yet … link a GitHub account" means the key's
  account isn't entitled yet (new GitHub accounts don't qualify until they age),
  not a proxy fault. Free routes never fall back to paid models, so a 429 there
  is a clean quota signal.

## Current additions

The authoritative list of models this install adds or edits — their platforms,
ids, and metadata — is `freellmapi.config.json` (the `models` array). Read that
file rather than a snapshot here; it is the source of truth and this document is
not kept in sync with it.
