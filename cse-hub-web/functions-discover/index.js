'use strict';
/**
 * Student Hub — Discover backend (own codebase "discover", region asia-south1 like quiz + syllabus).
 *   Student callables : discoverRefresh, discoverPostComment, discoverDeleteComment, discoverReportComment
 *   Owner callables   : discoverModList, discoverModAct          (Auth custom claim owner:true)
 *   Schedulers        : discoverDailyRefresh (05:30 IST, retries on failure), discoverEnsureFresh (every 6 h catch-up)
 * The ONLY secret is NEWSDATA_API_KEY (Firebase secret). DEV.to and Hacker News need no key.
 */
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

const R = require('./lib/refresh');
const C = require('./lib/comments');

setGlobalOptions({ region: 'asia-south1', maxInstances: 10, memory: '256MiB', timeoutSeconds: 60 });
const NEWSDATA_KEY = defineSecret('NEWSDATA_API_KEY');
const key = () => { try { return NEWSDATA_KEY.value(); } catch (e) { return ''; } };

const CALL = { cors: true };
const CALL_REFRESH = { cors: true, secrets: [NEWSDATA_KEY], timeoutSeconds: 300, memory: '512MiB' };

/* ---------- refresh ---------- */
exports.discoverRefresh = onCall(CALL_REFRESH, async (request) => {
  const uid = C.requireAuth(request);
  await C.rateLimit(uid, 'refresh', 4, 60);
  return R.runRefresh({ reason: 'manual', apiKey: key() });
});

exports.discoverDailyRefresh = onSchedule({
  schedule: '30 5 * * *', timeZone: 'Asia/Kolkata', region: 'asia-south1', secrets: [NEWSDATA_KEY], timeoutSeconds: 300, memory: '512MiB',
  retryCount: 3, minBackoffSeconds: 120, maxBackoffSeconds: 900,
}, async () => {
  const r = await R.runRefresh({ reason: 'daily', apiKey: key() });
  console.log('[discover] daily refresh', JSON.stringify({ state: r.state, ok: r.ok, added: r.added, updated: r.updated, sources: r.sources }));
  if (r.state === 'done' && !r.ok) throw new Error('daily refresh: every source failed');   // throwing makes Cloud Scheduler retry (retryCount above)
});

/* Catch-up: if the daily run never succeeded (all retries failed, outage…), try again within 6 h. One doc read when everything is fine. */
exports.discoverEnsureFresh = onSchedule({
  schedule: 'every 6 hours', timeZone: 'Asia/Kolkata', region: 'asia-south1', secrets: [NEWSDATA_KEY], timeoutSeconds: 300, memory: '512MiB',
}, async () => {
  const s = await R.db.doc('discoverMeta/refresh').get();
  const last = (s.exists && s.data().lastSuccessAtMs) || 0;
  if (Date.now() - last < 26 * 3600 * 1000) return;
  const r = await R.runRefresh({ reason: 'catchup', apiKey: key() });
  console.log('[discover] catch-up refresh', JSON.stringify({ state: r.state, ok: r.ok, added: r.added }));
});

/* ---------- comments ---------- */
exports.discoverPostComment = onCall(CALL, (request) => C.postComment(request));
exports.discoverDeleteComment = onCall(CALL, (request) => C.deleteComment(request));
exports.discoverReportComment = onCall(CALL, (request) => C.reportComment(request));
exports.discoverModList = onCall(CALL, (request) => C.modList(request));
exports.discoverModAct = onCall(CALL, (request) => C.modAct(request));
