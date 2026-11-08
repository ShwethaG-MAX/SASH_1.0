'use strict';
/**
 * Centralised refresh. The ONLY code that calls the external news APIs; browsers never do.
 *   - one global lock (discoverMeta/refresh) so two refreshes can never run at once, whoever triggers them
 *   - manual refreshes have a cool-down; the daily scheduler ignores it
 *   - each source has its own minimum interval, so extra refreshes do not burn the free NewsData quota
 *   - articles are upserted by a URL-derived id: a duplicate is merged, an existing article is never replaced,
 *     and comment counts / saved links (which live elsewhere or in untouched fields) survive every refresh
 */
const admin = require('firebase-admin');
const crypto = require('crypto');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue, TS = admin.firestore.Timestamp;

const { fetchDevTo } = require('./sources/devto');
const { fetchHN } = require('./sources/hn');
const { fetchNewsData, DAILY_BUDGET } = require('./sources/newsdata');
const { finalizeArticle, uniq } = require('./normalize');

const MIN = 60000, HOUR = 3600000;
const MANUAL_COOLDOWN = 20 * MIN, FAIL_COOLDOWN = 5 * MIN, RUN_TTL = 8 * MIN;
const INTERVAL = { devto: 25 * MIN, hn: 25 * MIN, newsdata: 6 * HOUR };
const META = () => db.doc('discoverMeta/refresh');
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

async function acquire(reason) {
  const now = Date.now(), runId = crypto.randomUUID();
  return db.runTransaction(async (t) => {
    const s = await t.get(META()), m = s.exists ? s.data() : {};
    if (m.status === 'running' && now - (m.startedAtMs || 0) < RUN_TTL) return { ok: false, state: 'running', startedAtMs: m.startedAtMs };
    if (reason === 'manual' && m.nextAllowedAtMs && now < m.nextAllowedAtMs) return { ok: false, state: 'cooldown', retryAfterMs: m.nextAllowedAtMs - now, lastSuccessAtMs: m.lastSuccessAtMs || 0 };
    t.set(META(), { status: 'running', runId, startedAtMs: now, lastAttemptAtMs: now, nextAllowedAtMs: now + MANUAL_COOLDOWN }, { merge: true });
    return { ok: true, runId, meta: m };
  });
}

/** Insert new articles, merge duplicates. Returns counts. Never touches commentCount / lastCommentAt. */
async function upsertArticles(list) {
  const byId = new Map();
  for (const a of list) {
    const f = finalizeArticle(a); if (!f) continue;
    const prev = byId.get(f.id);
    if (!prev) { byId.set(f.id, f); continue; }
    prev.domains = uniq([...prev.domains, ...f.domains]).slice(0, 4); prev.tags = uniq([...prev.tags, ...f.tags]).slice(0, 8);
    if (!prev.imageUrl && f.imageUrl) prev.imageUrl = f.imageUrl;
    if ((!prev.description || prev.sourceApi === 'hn') && f.description && f.sourceApi !== 'hn') { prev.description = f.description; }
    if (!prev.discussionUrl && f.discussionUrl) prev.discussionUrl = f.discussionUrl;
  }
  const all = [...byId.values()]; let added = 0, updated = 0;
  for (let i = 0; i < all.length; i += 200) {
    const chunk = all.slice(i, i + 200);
    const refs = chunk.map((a) => db.doc('discoverArticles/' + a.id));
    const snaps = await db.getAll(...refs);
    const batch = db.batch();
    snaps.forEach((snap, k) => {
      const a = chunk[k], ref = refs[k];
      if (!snap.exists) {
        const { id, publishedAt, ...rest } = a;
        batch.set(ref, Object.assign({}, rest, { publishedAt: TS.fromDate(publishedAt), fetchedAt: FV.serverTimestamp(), lastSeenAt: FV.serverTimestamp(), commentCount: 0 }));
        added++;
      } else {
        const d = snap.data(), up = { lastSeenAt: FV.serverTimestamp() };
        const dm = uniq([...(d.domains || []), ...a.domains]).slice(0, 6); if (dm.length !== (d.domains || []).length) up.domains = dm;
        const tg = uniq([...(d.tags || []), ...a.tags]).slice(0, 10); if (tg.length !== (d.tags || []).length) up.tags = tg;
        if (!d.imageUrl && a.imageUrl) up.imageUrl = a.imageUrl;
        if (!d.description && a.description) up.description = a.description;
        batch.update(ref, up); updated++;
      }
    });
    await batch.commit();
  }
  return { added, updated, considered: all.length };
}

/** @param {{reason:'manual'|'daily'|'catchup', apiKey?:string}} o */
async function runRefresh(o) {
  const reason = o.reason || 'manual';
  const lock = await acquire(reason);
  if (!lock.ok) return lock;
  const now = Date.now(), force = reason !== 'manual', m = lock.meta || {}, src = m.sources || {};
  const due = (k) => force || now - ((src[k] && src[k].lastOkAtMs) || 0) >= INTERVAL[k];
  const nd = src.newsdata || {}, used = nd.creditsDay === utcDay(now) ? (nd.creditsUsed || 0) : 0;
  const summary = { devto: { skipped: 'recent' }, hn: { skipped: 'recent' }, newsdata: { skipped: 'recent' } };
  const fresh = {}; let added = 0, updated = 0, anyOk = false, nowCredits = used;
  try {
    const jobs = [];
    if (due('devto')) jobs.push(['devto', fetchDevTo()]);
    if (due('hn')) jobs.push(['hn', fetchHN()]);
    if (due('newsdata')) {
      if (used >= DAILY_BUDGET) summary.newsdata = { ok: false, error: 'daily_budget' };
      else jobs.push(['newsdata', fetchNewsData({ apiKey: o.apiKey, creditsLeft: DAILY_BUDGET - used })]);
    }
    const settled = await Promise.allSettled(jobs.map((j) => j[1]));
    const articles = [];
    settled.forEach((r, i) => {
      const k = jobs[i][0];
      if (r.status === 'fulfilled') {
        articles.push(...r.value.articles);
        summary[k] = { ok: true, fetched: r.value.articles.length, failedRequests: r.value.failed || 0 };
        if (r.value.stoppedBy) summary[k].stoppedBy = r.value.stoppedBy;
        fresh[k] = { lastOkAtMs: Date.now() }; anyOk = true;
        if (k === 'newsdata') nowCredits = used + (r.value.creditsUsed || 0);
      } else {
        const code = (r.reason && r.reason.code) || 'error';
        summary[k] = code === 'no_key' ? { ok: false, skipped: 'no_key' } : { ok: false, error: String(code).slice(0, 40) };
        if (k === 'newsdata' && code !== 'no_key' && code !== 'budget') nowCredits = used + (r.reason && r.reason.creditsUsed != null ? r.reason.creditsUsed : 1);
        console.warn('[discover] source failed', k, code);
      }
    });
    if (articles.length) { const r = await upsertArticles(articles); added = r.added; updated = r.updated; }
    return { state: 'done', ok: anyOk, added, updated, sources: summary };
  } catch (e) {
    console.error('[discover] refresh crashed', e && e.message);
    return { state: 'done', ok: false, added, updated, sources: summary, error: 'internal' };
  } finally {
    const end = Date.now();
    const patch = {
      status: 'idle', finishedAtMs: end,
      lastResult: { atMs: end, reason, ok: anyOk, added, updated, sources: summary },
      nextAllowedAtMs: anyOk ? now + MANUAL_COOLDOWN : end + FAIL_COOLDOWN,
    };
    if (anyOk) patch.lastSuccessAtMs = end;
    Object.keys(fresh).forEach((k) => { patch['sources.' + k + '.lastOkAtMs'] = fresh[k].lastOkAtMs; });
    patch['sources.newsdata.creditsDay'] = utcDay(end); patch['sources.newsdata.creditsUsed'] = nowCredits;
    try { await META().update(patch); } catch (e) { try { await META().set({ status: 'idle', finishedAtMs: end, lastSuccessAtMs: anyOk ? end : undefined }, { merge: true }); } catch (x) { console.error('[discover] could not release lock', x && x.message); } }
  }
}

module.exports = { runRefresh, upsertArticles, MANUAL_COOLDOWN, db };
