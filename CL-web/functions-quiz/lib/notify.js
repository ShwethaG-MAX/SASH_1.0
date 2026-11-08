'use strict';
/**
 * Student Centro — Daily Quiz push notifications (FCM to each student's own phone).
 *
 *   sendReminders(slot)  'evening' | 'last'  → students whose quiz for today is NOT submitted (never started, or started but unfinished)
 *   sendResults()        → yesterday's finalised quizzes: personal rank / score / XP, a leaderboard summary for those who skipped it,
 *                          and — after a Sunday — the weekly leaderboard position.
 *
 * Who gets what is decided on the server from userProfiles (year/branch → quiz group) and quizAttempts, never from the phone.
 * Tokens come from deviceTokens/{uid} (written by the app; unreadable by clients). Opt-outs are the booleans `quiz` / `quizResults`
 * on that doc (missing = on, so phones that have not updated yet still get notified).
 * Every run is guarded by a notifEvents/{id} marker created with create(), so a retry or a double trigger can never notify twice.
 * Dependencies are injected (db, messaging, core) so the logic is unit-testable without Firebase.
 */
const CHANNEL = 'quiz';                       // Android channel; phones without it fall back to the manifest's default channel
const STALE = /registration-token-not-registered|invalid-registration-token/;

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const alreadyExists = (e) => !!e && (e.code === 6 || e.code === 'already-exists' || /ALREADY_EXISTS|already exists/i.test(String(e.message || '')));

function makeNotifier({ db, messaging, core }) {
  const { deriveGroup, istDate, addDays, weekId, quizKey, QUESTIONS_PER_QUIZ } = core;

  /** Everyone with a registered phone: [{uid, token, quiz, quizResults, name, groupId}] (group from the stored profile). */
  async function loadRecipients() {
    const snap = await db.collection('deviceTokens').get();
    const devs = [];
    snap.forEach((d) => { const x = d.data() || {}; if (x.token) devs.push({ uid: d.id, token: x.token, quiz: x.quiz !== false, quizResults: x.quizResults !== false }); });
    for (const part of chunk(devs, 300)) {
      const profs = await db.getAll(...part.map((d) => db.doc(`userProfiles/${d.uid}`)));
      profs.forEach((p, i) => {
        const data = p.exists ? p.data() : {};
        const g = deriveGroup(data);
        part[i].name = first(data.name); part[i].groupId = g ? g.groupId : '';
      });
    }
    return devs;
  }

  async function mark(id) {                      // true = we own this run; false = it was already done
    try { await db.doc(`notifEvents/${id}`).create({ createdAt: new Date().toISOString() }); return true; }
    catch (e) { if (alreadyExists(e)) return false; throw e; }
  }

  /** msgs: [{uid, token, title, body, tag}] → FCM. Returns {sent, failed, removed}. */
  async function deliver(msgs, route) {
    let sent = 0, failed = 0; const stale = [];
    for (const part of chunk(msgs, 500)) {
      const res = await messaging.sendEach(part.map((m) => ({
        token: m.token,
        notification: { title: m.title, body: m.body },
        data: { route, ref: '', sub: m.sub || '' },
        android: { priority: 'high', notification: { channel_id: CHANNEL, tag: m.tag } },
      })));
      res.responses.forEach((r, i) => {
        if (r.success) sent++;
        else { failed++; if (r.error && STALE.test(String(r.error.code || r.error.message || ''))) stale.push(part[i].uid); }
      });
    }
    for (const uid of stale) { try { await db.doc(`deviceTokens/${uid}`).delete(); } catch (e) { /* best effort */ } }
    return { sent, failed, removed: stale.length };
  }

  async function sendReminders(slot) {
    const date = istDate();
    const open = [];
    for (const g of Object.keys(core.GROUPS)) {
      const q = await db.doc(`dailyQuizzes/${quizKey(date, g)}`).get();
      if (q.exists && q.data().status === 'published') open.push(g);
    }
    if (!open.length) return { skipped: 'no open quiz today' };
    if (!(await mark(`quizrem_${date}_${slot}`))) return { skipped: 'already sent' };

    const status = {};                           // uid -> 'started' | 'submitted'
    for (const g of open) {
      const snap = await db.collection('quizAttempts').where('date', '==', date).where('groupId', '==', g).get();
      snap.forEach((d) => { const a = d.data(); if (a.uid) status[a.uid] = a.status; });
    }
    const msgs = [];
    for (const r of await loadRecipients()) {
      if (!r.quiz || !open.includes(r.groupId) || status[r.uid] === 'submitted') continue;
      const hi = r.name ? r.name + ', ' : '';
      if (slot === 'last') {
        msgs.push({ ...r, tag: 'quiz_remind', title: '⏰ Last call for today’s quiz',
          body: status[r.uid] === 'started' ? hi + 'your quiz is still unfinished. Submit before midnight to keep your place on the leaderboard.' : hi + 'today’s quiz closes at midnight. Solve it now to earn XP.' });
      } else {
        msgs.push({ ...r, tag: 'quiz_remind', title: '📝 Today’s Daily Quiz is waiting',
          body: status[r.uid] === 'started' ? hi + 'you started today’s quiz but haven’t submitted it yet. Finish it to earn XP.' : hi + 'you haven’t solved today’s quiz yet. It only takes a few minutes!' });
      }
    }
    return { date, slot, open, ...(await deliver(msgs, 'quiz')) };
  }

  async function sendResults() {
    const date = addDays(istDate(), -1), wk = weekId(date), weekEnded = wk !== weekId(addDays(date, 1));
    const out = {}; let recipients = null;
    for (const g of Object.keys(core.GROUPS)) {
      const key = quizKey(date, g);
      const q = await db.doc(`dailyQuizzes/${key}`).get();
      if (!q.exists || q.data().status !== 'finalized') { out[g] = 'not finalised'; continue; }
      if (!recipients) recipients = (await loadRecipients()).filter((r) => r.quizResults);
      const mine = recipients.filter((r) => r.groupId === g);

      if (await mark(`quizres_${key}`)) {
        const snap = await db.collection('dailyQuizResults').where('date', '==', date).where('groupId', '==', g).get();
        const rows = []; snap.forEach((d) => rows.push(d.data()));
        rows.sort((a, b) => a.rank - b.rank);
        const byUid = {}; rows.forEach((r) => { byUid[r.uid] = r; });
        const top = rows.slice(0, 3).map((r) => first(r.name) || 'Student').join(', ');
        const msgs = [];
        for (const r of mine) {
          const res = byUid[r.uid];
          if (res) {
            const title = res.rank === 1 ? '🥇 You topped yesterday’s quiz!' : res.rank <= 3 ? '🏅 You made the podium!' : '🏆 Daily Quiz results are in';
            msgs.push({ ...r, tag: 'quiz_result', title, body: `You ranked #${res.rank} of ${rows.length} · ${res.correctCount}/${QUESTIONS_PER_QUIZ} correct${res.xpAwarded ? ' · +' + res.xpAwarded + ' XP' : ''}.` });
          } else if (rows.length) {
            msgs.push({ ...r, tag: 'quiz_result', title: '🏆 Yesterday’s leaderboard is out', body: `Top scorers: ${top}. Solve today’s quiz to join them!` });
          }
        }
        out[g] = { participants: rows.length, ...(await deliver(msgs, 'quiz')) };
      } else out[g] = 'results already sent';

      if (weekEnded && (await mark(`quizweek_${wk}_${g}`))) {
        const snap = await db.collection('weeklyQuizResults').where('weekId', '==', wk).where('groupId', '==', g).get();
        const byUid = {}; let n = 0; snap.forEach((d) => { const w = d.data(); byUid[w.uid] = w; n++; });
        const msgs = mine.filter((r) => byUid[r.uid]).map((r) => ({ ...r, tag: 'quiz_week', sub: 'weekly', title: '📅 Weekly leaderboard',
          body: `You finished #${byUid[r.uid].rank || '–'} of ${n} this week with ${byUid[r.uid].totalXP || 0} XP.` }));
        out[g + '_weekly'] = await deliver(msgs, 'quiz');
      }
    }
    return { date, ...out };
  }

  return { sendReminders, sendResults };
}

module.exports = { makeNotifier, CHANNEL };
