#!/usr/bin/env node
/**
 * probe-context-length.mjs — empirically measure an OpenAI-compatible model's
 * context length by binary-searching token counts against the chat/completions
 * endpoint until requests fail with a context-length error.
 *
 * How it works:
 *   - Sends filler-text probes and reads the REAL token count from
 *     `usage.prompt_tokens` on every success (no client-side tokenizer needed).
 *   - When a probe fails, it can grow the probe by the actual/estimated ratio
 *     reported in the error (NVIDIA NIM returns details.actual), so the search
 *     stays meaningful when the filler tokenizes differently than predicted.
 *   - If the provider states an exact limit in the error body (NIM does:
 *     details.type="context_length", details.limit=…), that is reported as the
 *     authoritative verdict and short-circuits the search. NOTE: a stated
 *     limit comes from a *refusal* — pass --confirm to additionally send one
 *     accepted request at 0.97×limit and prove the boundary is really served.
 *   - 429s are throttling, NOT context failures: they are retried with backoff
 *     and never narrow the search.
 *
 * Usage:
 *   NIM_API_KEY=<key> node scripts/probe-context-length.mjs <modelId> [options]
 *
 * Options:
 *   --base <url>      Base URL (default https://integrate.api.nvidia.com/v1)
 *   --max-tokens <n>  Completion budget per probe, default 16. Keep small so
 *                     input + output stays inside the window when measuring.
 *   --hi <n>          Starting upper-bound guess for REAL tokens, default 1000000
 *   --tries <n>       Max probes, default 16
 *   --timeout <ms>    Per-request timeout, default 120000
 *   --confirm         After a stated-limit verdict, send one success-side
 *                     request at 0.97×limit (real prefill cost — use when you
 *                     actually rely on the number).
 *
 * Secrets come from the environment (NIM_API_KEY / NIM_BASE_URL), never a
 * committed file. For this install the current NIM key lives in
 * CREDENTIALS.local.md (gitignored).
 */
const argv = process.argv.slice(2);
if (!argv[0] || argv[0].startsWith('--')) {
  console.error('usage: probe-context-length.mjs <modelId> [--base url] [--max-tokens n] [--hi n] [--tries n] [--timeout ms]');
  process.exit(2);
}
const MODEL = argv[0];
const BASE = (process.env.NIM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
const KEY = process.env.NIM_API_KEY ?? process.env.NVIDIA_API_KEY ?? '';
if (KEY && KEY.toLowerCase().startsWith('freellmapi-')) {
  console.error('That is the proxy key, not the NIM backend key. Use the nvapi-… key from CREDENTIALS.local.md.');
  process.exit(2);
}
if (!KEY) {
  console.error('Set NIM_API_KEY=... (see CREDENTIALS.local.md for the current key)');
  process.exit(2);
}

const arg = (name, def) => {
  const i = argv.indexOf(name);
  const v = i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : def;
};
const MAX_TOKENS = arg('--max-tokens', 16);
let hiReal = arg('--hi', 1000000); // upper bound in REAL tokens (known failure)
const TRIES = arg('--tries', 16);
const TIMEOUT = arg('--timeout', 120000);
const CONFIRM = argv.includes('--confirm');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deterministic filler; sized in words, converted to REAL tokens via the
// calibrated wordsPerRealToken (taught by the server's own usage field).
const LEX = ['the','quick','brown','fox','jumps','over','lazy','dog','while','city'];
const filler = (words) =>
  Array.from({ length: words }, (_, i) => LEX[i % LEX.length] + Math.floor(i / LEX.length) % 97).join(' ');

// Parse a context-length error. Handles NIM's shape
// {"details":{"type":"context_length","limit":262144,"actual":315564}}
// and OpenAI-style prose ("maximum context length is 262144 tokens").
function parseError(raw) {
  try {
    const j = JSON.parse(raw);
    const d = j?.details;
    if (d?.type === 'context_length' && d.limit) {
      return { limit: Number(d.limit), actual: Number(d.actual) || null };
    }
  } catch { /* fall through to prose */ }
  const m = String(raw).match(/(\d{3,7})\s*tokens?\b[^\n]{0,80}?(?:maximum|exceed)/i)
      ?? String(raw).match(/(?:maximum|limit)[^\n]{0,50}?(\d{3,7})/i);
  return m ? { limit: Number(m[1]), actual: null } : null;
}

let wordsPerReal = 0.8; // initial ~1.25 real tokens/word guess; recalibrated by usage
const wpt = () => wordsPerReal;

async function probe(targetRealTokens) {
  const words = Math.max(1, Math.ceil(targetRealTokens / wpt()));
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a token counter. Reply with the single word: ok.' },
      { role: 'user', content: filler(words) },
    ],
    max_tokens: MAX_TOKENS,
    stream: false,
  };
  for (let attempt = 0; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const raw = await res.text();
      if (res.ok) {
        let usage = null;
        try { usage = JSON.parse(raw)?.usage ?? null; } catch { /* non-JSON */ }
        return { ok: true, promptTokens: usage?.prompt_tokens ?? null, words };
      }
      if (res.status === 429) {
        // Throttling — back off and retry; never treat as a context failure.
        const wait = 15000 * (attempt + 1);
        console.log(`  429 (throttled) — backing off ${wait / 1000}s…`);
        await sleep(wait);
        continue;
      }
      return { ok: false, status: res.status, raw, parsed: parseError(raw), words };
    } catch (e) {
      return { ok: false, status: 0, raw: String(e), words };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 429, raw: 'throttled after 3 backoffs', words, throttled: true };
}

(async () => {
  console.log(`probing ${MODEL} @ ${BASE} (max_tokens=${MAX_TOKENS}, upper bound ${hiReal})`);

  let loReal = null;       // known-success real token count (from usage)
  let exactLimit = null;   // provider-stated limit, once found
  let loName = 0, hiName = hiReal; // search bounds in real tokens
  const trail = [];
  const push = (target, r) => trail.push([target, r.ok ? `ok(${r.promptTokens ?? '?'})` : r.throttled ? 'throttled' : `fail(${r.status})`]);

  for (let i = 0; i < TRIES && hiName - loName > 1; i++) {
    const target = Math.round((loName + hiName) / 2);
    await sleep(2000); // stay friendly to rate limits between probes
    const r = await probe(target);
    push(target, r);

    if (r.ok) {
      if (r.promptTokens) {
        loReal = Math.max(loReal ?? 0, r.promptTokens);
        loName = r.promptTokens;
        if (wordsPerReal === 0.8) {
          wordsPerReal = r.promptTokens / r.words;
          console.log(`  calibrated: ${r.promptTokens} real tokens / ${r.words} words = ${wordsPerReal.toFixed(2)} tokens/word`);
        }
      } else {
        loName = Math.max(loName, target);
      }
      if (hiName - loName > 1) console.log(`  ok  target~${target} real=${r.promptTokens ?? '?'} lo=${loName}`);
    } else if (r.status === 429) {
      break; // cannot classify the boundary while throttled
    } else if (r.parsed?.limit) {
      exactLimit = r.parsed.limit;
      console.log(`  provider-stated limit: ${exactLimit} (actual=${r.parsed.actual ?? '?'})`);
      if (r.parsed.actual) {
        hiName = Math.min(hiName, r.parsed.actual);
        if (wordsPerReal === 0.8) {
          wordsPerReal = r.parsed.actual / r.words; // actual tokens per words filled
          console.log(`  calibrated from error: ${wordsPerReal.toFixed(2)} tokens/word`);
        }
      }
      break; // exact limit stated — search is over
    } else {
      hiName = Math.min(hiName, target);
      console.log(`  fail({${r.status}}) target~${target}`);
    }
  }

  let confirmResult = null;
  if (CONFIRM && exactLimit) {
    // Success-side check: prove a request just under the stated limit is
    // really served, instead of trusting a refusal to name the boundary.
    const target = Math.floor(exactLimit * 0.97);
    console.log(`\nconfirming stated limit ${exactLimit}: sending one request at ~${target} tokens…`);
    await sleep(2000);
    confirmResult = await probe(target);
    push(target, confirmResult);
  } else if (CONFIRM && !exactLimit) {
    console.log('\n--confirm ignored: no provider-stated limit to confirm.');
  }

  console.log('\n=== verdict ===');
  console.log('model:             ', MODEL, '@', BASE);
  if (exactLimit) console.log('provider-stated limit:', exactLimit, 'tokens (input+output)');
  if (loReal != null) console.log('max measured input:', loReal, 'prompt_tokens (server-reported usage,', `+${MAX_TOKENS} completion = ${loReal + MAX_TOKENS})`);
  if (confirmResult) {
    console.log(confirmResult.ok
      ? `success-side check: LOOKS REAL — ~${Math.floor(exactLimit * 0.97)} tokens accepted (prompt_tokens=${confirmResult.promptTokens ?? '?'})`
      : `success-side check: STATED LIMIT SUSPECT — request under the stated limit was REJECTED (HTTP ${confirmResult.status})`);
  }
  console.log('verdict:           ', exactLimit ?? (loReal != null ? `>= ${loReal}, boundary below ${hiName}` : 'unknown'));
  console.log('probe trail:       ', JSON.stringify(trail));
  process.exit(exactLimit || loReal ? 0 : 1);
})();
