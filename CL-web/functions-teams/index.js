'use strict';
/* Campus Loop — Team Building backend (codebase "teams", region asia-south1 like the rest of the project).
   Signed-in, non-guest students only. Clients read teams / requests / notifications straight from Firestore (see firestore.rules);
   every write goes through the callables below. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
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
  if (req.auth.token.firebase && req.auth.token.firebase.sign_in_provider === 'anonymous') throw new HttpsError('permission-denied', 'Sign in with your student account to use Teams (guests cannot).');
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