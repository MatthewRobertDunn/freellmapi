#!/usr/bin/env node
/**
 * get-provider-key.mjs — print one stored provider key to stdout, for
 * direct-backend tests that bypass the router (e.g. probing a provider's own
 * /v1/chat/completions to check its enforced limits).
 *
 * Server side this is GET /api/keys/export?format=json, which decrypts keys
 * with ENCRYPTION_KEY and needs password re-verification via the
 * x-reauth-password header (the dashboard password), plus a dashboard
 * bearer token. See server/src/routes/keys.ts (`keysRouter.get('/export')`).
 *
 * Usage:
 *   DT='<dashboard-token>' DASH_PASSWORD='<dashboard-password>' \
 *     node scripts/get-provider-key.mjs <platform> [--label <label>] [--base <url>]
 *
 * Env:
 *   DT              Dashboard session token (mint via POST /api/auth/login).
 *                   Falls back to FREEAPI_DT.
 *   DASH_PASSWORD   Dashboard password for x-reauth-password.
 *   FREEAPI_BASE    Server base URL (default http://192.168.0.2:3001).
 *
 * SECURITY: stdout IS the secret. Capture it straight into a variable and
 * never print, log, or commit it:
 *   ORCA_KEY=$(DT=... DASH_PASSWORD=... node scripts/get-provider-key.mjs orcarouter)
 *   curl ... -H "Authorization: Bearer $ORCA_KEY" ...
 *   unset ORCA_KEY
 * If several keys exist for one platform, disambiguate with --label (run
 * without it to list labels — keys are never listed).
 */
const argv = process.argv.slice(2);
const platform = argv[0];
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
if (!platform || platform.startsWith('--')) {
  console.error('usage: node scripts/get-provider-key.mjs <platform> [--label <label>] [--base <url>]');
  process.exit(2);
}
const base = (flag('--base') || process.env.FREEAPI_BASE || 'http://192.168.0.2:3001').replace(/\/$/, '');
const token = process.env.DT || process.env.FREEAPI_DT;
const password = process.env.DASH_PASSWORD;
if (!token) { console.error('error: set DT (dashboard session token)'); process.exit(1); }
if (!password) { console.error('error: set DASH_PASSWORD (dashboard password, for x-reauth-password)'); process.exit(1); }

const res = await fetch(`${base}/api/keys/export?format=json`, {
  headers: { Authorization: `Bearer ${token}`, 'x-reauth-password': password },
});
if (!res.ok) {
  const body = await res.text().catch(() => '');
  console.error(`error: export failed HTTP ${res.status}: ${body.slice(0, 200)}`);
  process.exit(1);
}
const body = await res.json().catch(() => null);
const keys = Array.isArray(body) ? body : body?.keys;
if (!Array.isArray(keys)) { console.error('error: unexpected export shape'); process.exit(1); }
const matches = keys.filter((k) => k?.platform === platform && typeof k?.key === 'string' && k.key);
if (matches.length === 0) { console.error(`error: no stored key for platform '${platform}'`); process.exit(1); }
const label = flag('--label');
if (!label && matches.length > 1) {
  console.error(`error: ${matches.length} keys for '${platform}', pick one with --label:`);
  for (const m of matches) console.error(`  --label '${m.label || '(no label)'}'`);
  process.exit(1);
}
const hit = label ? matches.find((m) => (m.label || '') === label) : matches[0];
if (!hit) { console.error(`error: no '${platform}' key labelled '${label}'`); process.exit(1); }
process.stdout.write(hit.key + '\n');
