'use strict';
/* Account functions (codebase "account", region asia-south1 — MUST match the website).
   accountDelete({confirm:'DELETE'}) -> permanent account deletion (everything that belongs to the caller, then the Firebase Auth user).
     Requires a RECENT sign-in (auth_time within 5 minutes): the website re-authenticates the student right before calling it.
   adminGrant({email}) / adminRevoke({uid}) / adminList() -> admin access management (main admin only for grant / revoke). See lib/admins.js. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
// Modular firebase-admin imports: work on firebase-admin 12, 13 and 14+ (the old `admin.firestore()` / `admin.auth()` namespace API was removed in v13).
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const core = require('./lib/core');
const admins = require('./lib/admins');

setGlobalOptions({ region: 'asia-south1', maxInstances: 5 });
initializeApp();
const db = getFirestore();
const FV = FieldValue;

exports.accountDelete = onCall({ cors: true, timeoutSeconds: 540, memory: '512MiB' }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in again.');
  try {
    return await core.deleteAccount({
      db, FV, nowMs: Date.now(),
      deleteFiles: (prefix) => getStorage().bucket().deleteFiles({ prefix, force: true }),
      deleteAuthUser: (uid) => getAuth().deleteUser(uid),
    }, req.auth.uid, req.auth.token, req.data);
  } catch (e) {
    if (e instanceof core.CoreError) throw new HttpsError(e.code, e.message);
    console.error('accountDelete failed', e);
    throw new HttpsError('internal', 'Could not finish deleting your account. Nothing was lost: please try again.');
  }
});

const adminCall = (name, fn) => onCall({ cors: true }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in again.');
  try { return await fn({ auth: getAuth(), db, FV }, req.auth.uid, req.data); } catch (e) {
    if (e instanceof admins.AdminError) throw new HttpsError(e.code, e.message);
    console.error(name + ' failed', e);
    throw new HttpsError('internal', 'Something went wrong. Please try again.');
  }
});
exports.adminGrant = adminCall('adminGrant', admins.grantAdmin);
exports.adminRevoke = adminCall('adminRevoke', admins.revokeAdmin);
exports.adminList = adminCall('adminList', admins.listAdmins);