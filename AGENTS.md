# AGENTS.md — Maintaining models on this FreeLLMAPI install

This checkout (`/home/matty/freellmapi`, branch `matty`) is a source install of
FreeLLMAPI running as a **systemd user service** in **production mode**. This
document covers adding, changing, testing, and removing models. The
authoritative model list is the `models` array in `freellmapi.config.json` —
read it rather than any snapshot here.

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

> Production mode auto-runs DB migrations at startup. Do **not** run
> `npm run db:migration:up` against this database; that path is for
> `NODE_ENV=development` only.

## TL;DR — add or change a model

1. Add/edit an entry in the `models` array of `freellmapi.config.json`.
2. `systemctl --user restart freellmapi.service`
3. Verify (see [Apply & verify](#apply--verify)).

## Credentials

Local-only credentials (dashboard email/password, session token, proxy key,
per-provider keys) live in **`CREDENTIALS.local.md`** — gitignored (`*.local.md`),
so they never land in a commit. It also holds copy-paste recipes for the
dashboard API and proxy tests.

- **Dashboard session token** → `Authorization: Bearer <token>` (or
  `x-dashboard-token:`) authorizes **`/api/*`**. Mint via `POST /api/auth/login`;
  it can expire.
- **Proxy key** (`freellmapi-…`) authorizes **`/v1/*`** only — never `/api/*`.

## How the declarative config is wired

`server/src/index.ts` calls `applyDeclarativeConfigFromEnv()` in `main()`,
after `initDb()` and before the HTTP listener starts. Implementation:
`server/src/services/declarative-config.ts`. Wired via `.env`:

```env
FREEAPI_CONFIG_PATH=/home/matty/freellmapi/freellmapi.config.json
```

- `FREEAPI_CONFIG_JSON` (inline JSON) wins over `FREEAPI_CONFIG_PATH` if both
  are set. This install uses the file.
- The top level is **strict** — only `admin`, `license`, `keys`,
  `customProviders`, `models`, `fallback`, `routing` are accepted; an unknown
  key fails the whole apply.
- The config applies inside one DB transaction and is **idempotent** — existing
  rows are updated in place, never duplicated.

## The `models` entry

A `models` entry adds a model or edits an existing one.

| Field | Type | Meaning |
|---|---|---|
| `platform` | string, **required** | Provider slug, e.g. `nvidia`. Must match a registered provider or the row cannot route. |
| `modelId` | string, **required** | The provider's exact model id, e.g. `z-ai/glm-5.3`. |
| `displayName` | string | Dashboard label. Defaults to `modelId`. **Also determines the unified routing key** (see below) — include it in every entry. |
| `intelligenceRank` | int 1–1000 | Lower = smarter (router orders `intelligence_rank ASC`). Frontier ≈ 1–40. |
| `speedRank` | int | Lower = faster (catalog uses 1–10). |
| `sizeLabel` | string ≤ 40 | Capability tier: `Small` / `Medium` / `Large` / `Frontier`; dominates the intelligence score. |
| `contextWindow` | int / null | Context window in tokens. |
| `supportsVision` | bool | Only with probe- or provider-verified support. |
| `supportsTools` | bool | Only with probe- or provider-verified support. |
| `rpmLimit` / `rpdLimit` / `tpmLimit` / `tpdLimit` | int / null | Per-key rate limits. |
| `monthlyTokenBudget` | string ≤ 80 | Free-form display string, e.g. `~2M (credits)`. |
| `enabled` | bool | Default `true`. `false` keeps the row but stops routing. |
| `fallbackEnabled` | bool | Default `true`. `false` keeps the model out of the fallback chain. |
| `endpoint` | string | For `custom` rows only: which relay the entry means (required when several serve the same id). |

Behavior:

- **New `(platform, modelId)`** → inserted with `source = 'user'`; catalog sync
  never updates or prunes user-owned rows.
- **Existing row** → patched; for catalog-managed rows an **override** is
  recorded so the next sync cannot clobber the change.
- Either way the entry ensures `fallback_config` + `profile_models` rows, so a
  newly declared model is immediately routable.

Set capability fields only to values a probe or the provider backs up — **no
invented facts**. An omitted field is honest ("unknown"); a wrong value ships a
bug.

Minimal:

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

Slugs are the `platform:` values registered in `server/src/providers/index.ts`
(e.g. `nvidia`, `openrouter`, `groq`, `custom`). A typo produces an unroutable
row.

## Fallback order and routing

```json
{
  "models": [ { "platform": "nvidia", "modelId": "z-ai/glm-5.3" } ],
  "fallback": [ { "platform": "nvidia", "modelId": "z-ai/glm-5.3", "priority": 1 } ],
  "routing": { "strategy": "balanced" }
}
```

- `fallback`: `priority` defaults to array index; entries take `platform`,
  `modelId`, optional `endpoint` (for custom relays), `enabled`.
- `routing.strategy`: `priority` | `balanced` | `smartest` | `fastest` |
  `reliable` | `custom` | `decision`; optional `weights` (`reliability`,
  `speed`, `intelligence`) for `custom`; optional `keySelectionStrategy`
  (`auto` | `least-remaining`) — which key of a platform to reach for.

## Pinning one provider's copy of a model

With unify ON, one logical name (e.g. `glm-5.3-flash`) covers several providers'
rows, and a bare `id` resolves to the whole group — the router picks the best
available member and may fail over. To target **one** provider's copy, send:

```
platform:model_id
```

E.g. `orcarouter:z-ai/glm-5.3-flash-free` forces the OrcaRouter row. `memberId(row)`
is `` `${row.platform}:${row.model_id}` `` (`server/src/services/model-groups.ts`,
`resolveRequestedIdToTieredMembers`); this exact match is checked before the
bare `model_id` scan. The separator is a **colon** — `orcarouter/...` (slash) is
a literal model id and 404s.

For `custom` relays sharing a model id, append an endpoint:
`custom:model_id#<endpoint-handle-or-url>`. A bare `custom:<model_id>` is
ambiguous once two relays serve the same id.

**How the unified routing key is derived** (`normalizeGroupKey` in
`server/src/services/model-groups.ts`): from the row's **displayName**, not the
model id. The provider suffix `" (…)"` is stripped (`stripProviderSuffix`), then
the name is lowercased with whitespace/hyphens/underscores collapsed — `GLM 5.3
Flash (NV)`, `GLM-5.3 Flash (APINex Free)` and `GLM 5.3 Flash (AxForge)` all
group under one key. Consequences:

- **Renaming a displayName moves the row between groups.** Dropping `1017` from
  `DeepSeek V4.1 Flash 1017 (CheapLLM)` folded it into the
  `deepseek-v4.1-flash` group; the old slug disappears from `/v1/models`.
- Rows with no `" (…)"` suffix group on the bare name — the suffix is cosmetic
  for grouping; keep it so rows stay distinguishable on the dashboard.
- Different stripped names (`Llama 3.3 70B fp8-fast` vs `Llama 3.3 70B`) stay
  separate by design; only an operator override (`PUT /api/settings/unify`,
  `merges`) can join them.

## Providers that need a key

Adding a model does not add credentials. Provide a key in the dashboard (Keys
page) or declaratively:

```json
{ "keys": [ { "platform": "nvidia", "key": "nvapi-...", "label": "main" } ] }
```

A `keys` entry carries a plaintext secret — keep secrets out of committed
files; `.env`/the config are protected only by filesystem permissions.

## Apply & verify

```bash
# 1. Validate JSON
node -e 'JSON.parse(require("fs").readFileSync("freellmapi.config.json","utf8"))'

# 2. Apply (config is read on boot)
systemctl --user restart freellmapi.service

# 3. Confirm the apply
journalctl --user-unit freellmapi.service --no-pager | grep '\[config\] applied'

# 4. Confirm rows in the DB
node -e 'const D=require("better-sqlite3");
const db=new D("server/data/freeapi.db",{readonly:true});
console.table(db.prepare(
  "SELECT platform,model_id,display_name,source,enabled FROM models WHERE platform=?"
).all("nvidia"));'
```

Healthy apply log:

```
[config] applied /home/matty/freellmapi/freellmapi.config.json: 0 keys, 0 custom models, 6 model edits, 6 fallback rows
```

Per-entry problems are warnings and **skipped**, not fatal — check the
`entries skipped` suffix and grep for `[config]` warnings.

## Probing a provider directly

To test a provider backend without the router (e.g. a large probe the local
context gate would refuse, or an upstream error body verbatim), use the
provider's key from `CREDENTIALS.local.md` and its base URL. NVIDIA NIM:
`https://integrate.api.nvidia.com/v1/`.

```bash
export NIM_API_KEY='<nvapi key from CREDENTIALS.local.md>'
curl -s https://integrate.api.nvidia.com/v1/chat/completions \
  -H "Authorization: Bearer $NIM_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"<modelId>","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

### Context length

**Always set `contextWindow` for NIM models.** First value (plus
`supportsTools`/`supportsVision`) comes from the model's build.nvidia.com page
(Specifications/Capabilities blocks). Trust order:

1. `details.limit` in a context-length **error body** — the serving stack's own
   enforcement value; a rejected probe fails before prefill, so it costs
   ~nothing.
2. The page's **Specifications** section.
3. The card prose (marketing) — never authoritative.

Verify with one probe:

```bash
NIM_API_KEY=$NIM_API_KEY node scripts/probe-context-length.mjs <modelId>
# options: --base <url> --max-tokens 16 --hi <upper-bound-guess> --tries 16 --timeout 120000 --confirm
# base URL override: NIM_BASE_URL=<url>
```

- The default first probe (~500k tokens) lands above most NIM limits and 400s
  with `details.limit=<L>`; `L !=` page spec means the page was wrong — use `L`.
- If the first probe is accepted, the real context exceeds the guess and the
  script keeps doubling until it errors.
- `--confirm`: after a stated-limit verdict, sends one accepted request at
  0.97×L — use when routing will rely on the number. Costs a real prefill
  (~L tokens, slow).
- NIM context errors look like
  `{"details":{"type":"context_length","limit":262144,"actual":315564}}` — the
  limit counts input **and** output tokens.
- Large prefills hit token-per-minute 429s quickly; pace probes. With `--hi 2M`
  the first probe targets ~1M tokens — relays that state their limit in the
  error body answer exactly from one rejection.
- HTTP 413s are request-body-size limits, not context errors.

## Retrieving a stored provider key

`GET /api/keys/export?format=json` (`server/src/routes/keys.ts`) reads encrypted
keys back out. Requires **both** `Authorization: Bearer <dashboard token>` and
`x-reauth-password: <dashboard password>`.

`scripts/get-provider-key.mjs` wraps it:

```bash
ORCA_KEY=$(DT='<dashboard token>' DASH_PASSWORD='<dashboard password>' \
  node scripts/get-provider-key.mjs orcarouter)
curl -s https://api.orcarouter.ai/v1/chat/completions \
  -H "Authorization: Bearer $ORCA_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"<modelId>","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
unset ORCA_KEY
```

- One argument: the provider slug. Several keys per platform → `--label`; run
  bare to list labels.
- The script prints **only the key** to stdout — treat stdout as the secret:
  never echo, log, or commit it.

## Custom (non-catalog) endpoints

For an OpenAI-compatible relay that is not a registered provider: endpoint +
key + model rows via the dashboard API (Step 2), then per-model metadata via
the declarative config (Step 3).

### Step 1 — probe the endpoint directly

Key from `CREDENTIALS.local.md`; `$BASE` = the relay's base URL:

```bash
# 0. Confirm exact model id(s) the key can see
curl -s "$BASE/v1/models" -H "Authorization: Bearer $KEY"

# 1. Chat: must return content, not an error envelope
curl -s "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"<id>","messages":[{"role":"user","content":"Reply with exactly: PONG"}],"max_tokens":200}'

# 2. Tools: test BOTH tool_choice:"auto" and the forced form. Some relays
#    ignore the forced form but still do tools under auto — judge
#    supportsTools by the auto result.

# 3. Vision (only if claimed): send a locally generated image (e.g. ImageMagick
#    text render) as a data URL and ask what word it contains — must not be
#    guessable blind. A plan-level 400 (e.g. `vision_disabled_free_plan`) is a
#    NO: record supportsVision:false, do not leave it unset.

# 4. Context (when it feeds routing):
NIM_API_KEY=$KEY NIM_BASE_URL=$BASE node scripts/probe-context-length.mjs <id> --hi 2000000
```

Heavy-reasoning models may need `max_tokens` in the thousands to finish
thinking before answering (a vision probe that returns empty content with all
reasoning tokens is inconclusive, not a failure).

### Step 2 — register endpoint + key + models (dashboard API)

The config file is git-tracked — keys go into the encrypted `api_keys` table:

```bash
curl -s -X POST http://192.168.0.2:3001/api/keys/custom \
  -H "Authorization: Bearer <dashboard token>" -H 'Content-Type: application/json' \
  -d '{
    "baseUrl": "https://relay.example/v1",
    "apiKey": "<secret>",
    "label": "RelayName",
    "models": ["model-id-one", "model-id-two"],
    "supportsTools": true
  }'
```

- Creates one `api_keys` row (`platform='custom'`, `base_url`, label) + one
  `models` row per id (`modelDbId` in the response) — note the row ids.
- `label` names the endpoint on the Keys page (defaults to the host).
- Second key for the same endpoint: same call again with the same `baseUrl` and
  the new `apiKey` (matching is on `(base_url, secret)`, so it INSERTs).
- `POST /api/keys/custom/discover-models` lists what an endpoint serves before
  committing.

### Step 3 — patch metadata via the declarative config

Add entries with `"platform": "custom"` **and** `"endpoint": "<baseUrl>"`:

```json
{
  "platform": "custom",
  "endpoint": "https://relay.example/v1",
  "modelId": "model-id-one",
  "displayName": "Model One (RelayName)",
  "intelligenceRank": 35,
  "contextWindow": 1000000,
  "supportsVision": false,
  "supportsTools": true,
  "tpdLimit": 125000,
  "fallbackEnabled": true
}
```

These entries **edit** the rows created in Step 2 — a custom `models` entry
cannot create a routable row on its own (no `key_id`/`base_url`; a no-match
endpoint is refused with "register it under 'customProviders' first"). The
config-only `customProviders` alternative puts the key in a git-tracked file —
use the API flow instead.

### Step 4 — apply & verify

Same as [Apply & verify](#apply--verify); check displayName, ranks,
contextWindow, supportsVision/Tools, rate limits on the new rows.

### Step 5 — test through the proxy

```
custom:<model_id>#<baseUrl>     # pinned to ONE relay — always use this form
```

### Custom-endpoint gotchas

- A `401 invalid_key` at the given URI usually means a mis-pasted URI — try the
  domain the key name implies and confirm the real base URL with the operator.
- Free tiers can gate features per plan (`free_credit_verification_required`
  for all inference, `vision_disabled_free_plan` for image input). A gate is an
  operator action at the provider's dashboard, not a proxy fault — probe,
  report, retry.
- Some relays enforce a per-message cooldown (e.g. 7s) — set `rpmLimit`
  accordingly (60/cooldown-seconds, floored to int).
- `DELETE /api/models/<id>` on a custom row also removes the endpoint's key
  when no rows use it (`deleteUnusedCustomEndpointKey`) — deleting the last
  model of an endpoint drops the key too.

## Deleting a model

Deleting removes the row **and writes a tombstone**, so catalog sync cannot
resurrect it:

| Action | `/v1/models` | Routing |
|---|---|---|
| Disable (`enabled: false`) | Still listed, tagged `available: false` | Stopped |
| Delete | **Gone from the list** | Gone |

Do not delete by writing to the DB by hand — that skips the tombstone and
cleanup side effects, and the row returns on the next catalog sync.

1. **Dashboard token** (the proxy key does not authorize `/api/*`).
2. **Find the row's integer id** (one row per provider per model):

   ```bash
   curl -s -H "Authorization: Bearer <dashboard token>" \
     http://192.168.0.2:3001/api/models | \
     node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const r of JSON.parse(d)) console.log(r.id, r.platform, r.modelId)})'
   ```

3. **Delete by id** (per id for every provider copy being removed):

   ```bash
   curl -s -X DELETE -H "Authorization: Bearer <dashboard token>" \
     http://192.168.0.2:3001/api/models/<id>
   # → {"success":true,...}; a second call returns 404
   ```

4. **Verify:**

   ```bash
   curl -s -H "Authorization: Bearer <dashboard token>" http://192.168.0.2:3001/api/models | \
     node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log("left:",(Array.isArray(j)?j:[]).length)})'
   node -e 'const D=require("better-sqlite3");
   const db=new D("server/data/freeapi.db",{readonly:true});
   console.table(db.prepare("SELECT kind,platform,model_id,source FROM catalog_model_tombstones ORDER BY created_at DESC LIMIT 5").all());'
   ```

Deletion (`server/src/routes/models.ts`, `modelsRouter.delete('/:id')`) records
a `catalog_model_tombstones` row with `source='user'`, clears
`profile_models`/`fallback_config`, and deletes the `models` row in one
transaction. Upstream EOL retirements use `source='upstream_eol'` instead and
keep the row disabled; a later catalog can reinstate those, a user tombstone
cannot (only re-adding the model).

## Gotchas

- **Deleting a unified-group member affects the group.** Deleting a member row
  drops that provider copy (merge membership, fallback, profile state) but not
  the other providers' rows.
- **Deletions survive restarts and catalog syncs.** Only declaring the model
  again in `freellmapi.config.json` clears the tombstone (`upsertModel()` — a
  declaration is operator intent to restore). The config file can only add or
  edit, never delete: remove the declarative entry *before* deleting a model.
- **`ENCRYPTION_KEY` must stay stable.** Provider keys are encrypted at rest
  with it; changing it breaks every stored secret. Lives in `.env` (mode 600).
- **No hot reload** — restart after editing the config.
- **No rebuild for config-only changes.** `npm run build` is only needed after
  editing TypeScript under `server/`, `client/`, `shared/`, or `cli/`.
- **Binding:** the server listens on `HOST` from `.env` (currently
  `192.168.0.2`), not loopback. First-run setup code:
  `journalctl --user-unit freellmapi.service | grep 'setup code' | tail -1`.
- **Free-route 429s / account gates are quota signals, not faults.** A 429
  telling you to link an account means the key's account isn't entitled yet —
  fix at the provider's dashboard. Free routes never fall back to paid models,
  so a 429 there is a clean quota signal.
