'use strict';
const UA = 'CSE-Hub-Discover/1.0 (student community app; +https://cse-c-hub.firebaseapp.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SourceError extends Error {
  constructor(code, status, fatal) { super(code); this.code = code; this.status = status || 0; this.fatal = !!fatal; }
}

/**
 * GET JSON with a timeout and a small retry budget (network errors, timeouts, 429, 5xx). Honours Retry-After (capped at 8 s).
 * Other 4xx errors and bad JSON are "fatal": retrying cannot help. Errors carry only a short code + HTTP status — never the URL,
 * because some URLs contain API keys.
 */
async function getJson(url, o) {
  o = o || {};
  const retries = o.retries == null ? 2 : o.retries, timeoutMs = o.timeoutMs || 12000;
  let last = new SourceError('network');
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
    let wait = 600 * Math.pow(3, i);
    try {
      const res = await fetch(url, { headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' }, o.headers || {}), signal: ac.signal });
      if (res.ok) {
        try { return await res.json(); } catch (e) { throw new SourceError('bad_json', res.status, true); }
      }
      const code = res.status === 429 ? 'rate_limited' : (res.status === 401 || res.status === 403) ? 'auth' : res.status >= 500 ? 'server' : 'http_' + res.status;
      const retryable = res.status === 429 ? !o.noRetryOn429 : res.status >= 500;
      last = new SourceError(code, res.status, !retryable);
      wait = Math.min(8000, (parseFloat(res.headers.get('retry-after')) || 0) * 1000) || wait;
    } catch (e) {
      last = e instanceof SourceError ? e : new SourceError(e && e.name === 'AbortError' ? 'timeout' : 'network');
    } finally { clearTimeout(t); }
    if (last.fatal || i === retries) throw last;
    await sleep(wait);
  }
  throw last;
}

/** Run async `fn` over `items` with at most `limit` in flight. Never rejects: each result is {ok,value|error}. */
async function pool(items, limit, fn, gapMs) {
  const out = new Array(items.length); let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { ok: true, value: await fn(items[i], i) }; } catch (e) { out[i] = { ok: false, error: e }; }
      if (gapMs) await sleep(gapMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

module.exports = { getJson, pool, sleep, SourceError, UA };
