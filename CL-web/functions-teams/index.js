'use strict';
/* Campus Loop — Team Building backend (codebase "teams", region asia-south1 like the rest of the project).
   Signed-in, non-guest students only. Clients read teams / requests / notifications straight from Firestore (see firestore.rules);
   every write goes through the callables below. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { getMessaging } = require('firebase-admin/messaging');
// Modular firebase-admin imports: work on firebase-admin 12, 13 and 14+ (the old `admin.firestore()` namespace API was removed in v13).
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const core = require('./lib/core');

setGlobalOptions({ region: 'asia-south1', maxInstances: 10, memory: '256MiB', timeoutSeconds: 30 });
initializeApp();
const db = getFirestore();
const FV = FieldValue;

const student = (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in to use Teams.');
  // Guests (anonymous accounts) may use Teams too.
  return req.auth.uid;
};
const call = (fn) => onCall({ cors: true }, async (req) => {
  const uid = student(req);
  try { return await fn({ db, FV, nowMs: Date.now() }, uid, req.data); } catch (e) {
    if (e instanceof core.CoreError) throw new HttpsError(e.code, e.message);
    if (e instanceof HttpsError) throw e;
    console.error('teams function failed', e);
    throw new HttpsError('internal', 'Something went wrong. Please try again.');
  }
});

exports.teamCreate = call(core.createTeam);
exports.teamUpdate = call(core.updateTeam);
exports.teamDelete = call(core.deleteTeam);
exports.teamRequestSend = call(core.sendRequest);
exports.teamRequestCancel = call(core.cancelRequest);
exports.teamRequestDecide = call(core.decideRequest);
exports.teamRemoveMember = call(core.removeMember);
exports.teamSetRole = call(core.setMemberRole);
exports.teamLeave = call(core.leaveTeam);
exports.teamTransfer = call(core.transferLeader);
exports.teamInviteSend = call(core.inviteSend);
exports.teamInviteCancel = call(core.inviteCancel);
exports.teamInviteDecide = call(core.inviteDecide);

/* Reminds every member of a team when a registered hackathon's deadline or start date is close (see core.sendDeadlineReminders). */
exports.teamDeadlineReminders = onSchedule({ schedule: 'every 6 hours', timeZone: 'Asia/Kolkata', region: 'asia-south1', timeoutSeconds: 120 }, async () => {
  const r = await core.sendDeadlineReminders({ db, FV, nowMs: Date.now() });
  console.log('teamDeadlineReminders sent', r.sent);
});


/* Follower count shown on another student's profile (Connect > People > View profile).
   Connections are private to the two students involved (firestore.rules), so the browser cannot count another student's connections itself.
   This returns ONLY the number, never who they are. A connection is mutual, so followers = number of connections. */
exports.peerFollowers = onCall({ cors: true }, async (req) => {
  student(req);
  const uid = req.data && req.data.uid;
  if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new HttpsError('invalid-argument', 'Invalid student.');
  try {
    const snap = await db.collection('connections').where('users', 'array-contains', uid).count().get();
    return { count: snap.data().count };
  } catch (e) {
    console.error('peerFollowers failed', e);
    throw new HttpsError('internal', 'Could not load followers right now.');
  }
});

/* Phone push for invites, join requests, removed/left/disbanded/transferred and deadline/start reminders. Uses the phone's FCM token (deviceTokens/{uid}), the existing "Connections & Teams" channel,
   and route 'connect' (sub 'requests' for join requests, otherwise 'teams'), so tapping opens the right Connect tab. No Android app update is needed. */
exports.teamNotifPush = onDocumentCreated({ document: 'teamNotifs/{uid}/items/{id}', region: 'asia-south1' }, async (event) => {
  const n = event.data && event.data.data(); if (!n || !core.PUSH_TYPES.includes(n.type)) return;
  const msg = core.pushText(n); if (!msg) return;
  const snap = await db.doc(`deviceTokens/${event.params.uid}`).get(); const token = snap.exists && snap.data().token; if (!token) return;
  try {
    await getMessaging().send({ token, notification: msg, data: { route: 'connect', ref: String(n.teamId || ''), sub: core.pushSub(n) }, android: { priority: 'high', notification: { channel_id: 'connections', tag: core.pushTag(n) } } });
  } catch (e) {
    if (/registration-token-not-registered|invalid-registration-token/.test(String((e && e.code) || (e && e.message) || ''))) { try { await snap.ref.delete(); } catch (x) { /* best effort */ } }
    else console.error('teamNotifPush failed', e);
  }
});
