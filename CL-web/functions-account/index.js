'use strict';
/* Permanent account deletion. Region MUST match the website (asia-south1).
   accountDelete({confirm:'DELETE'}) -> deletes everything that belongs to the caller, then the Firebase Auth user.
   Requires a RECENT sign-in (auth_time within 5 minutes): the website re-authenticates the student right before calling it. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const core = require('./lib/core');

setGlobalOptions({ region: 'asia-south1', maxInstances: 5 });
admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

exports.accountDelete = onCall({ cors: true, timeoutSeconds: 540, memory: '512MiB' }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in again.');
  try {
    return await core.deleteAccount({
      db, FV, nowMs: Date.now(),
      deleteFiles: (prefix) => admin.storage().bucket().deleteFiles({ prefix, force: true }),
      deleteAuthUser: (uid) => admin.auth().deleteUser(uid),
    }, req.auth.uid, req.auth.token, req.data);
  } catch (e) {
    if (e instanceof core.CoreError) throw new HttpsError(e.code, e.message);
    console.error('accountDelete failed', e);
    throw new HttpsError('internal', 'Could not finish deleting your account. Nothing was lost: please try again.');
  }
});
