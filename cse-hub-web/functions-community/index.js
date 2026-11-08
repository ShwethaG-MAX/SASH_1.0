'use strict';
/* Community chat reporting + moderation. Region MUST match the website (asia-south1). Admin = custom claim owner:true. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const core = require('./lib/core');

setGlobalOptions({ region: 'asia-south1', maxInstances: 10 });
admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const wrap = (fn) => async (req) => {
  try { return await fn(req); } catch (e) {
    if (e instanceof core.CoreError) throw new HttpsError(e.code, e.message);
    if (e instanceof HttpsError) throw e;
    console.error('community function failed', e);
    throw new HttpsError('internal', 'Something went wrong. Please try again.');
  }
};

exports.chatReport = onCall({ cors: true, timeoutSeconds: 30, memory: '256MiB' }, wrap(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please wait for your account to connect, then try again.');
  return core.createReport({ db, FV, nowMs: Date.now() }, req.auth.uid, req.data);
}));

exports.chatModerate = onCall({ cors: true, timeoutSeconds: 60, memory: '256MiB' }, wrap(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in.');
  if (req.auth.token.owner !== true) throw new HttpsError('permission-denied', 'Admin only.');
  return core.moderate({ db, FV, Timestamp, nowMs: Date.now() }, req.auth.uid, req.data);
}));
