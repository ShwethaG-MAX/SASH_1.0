'use strict';
/* Student connections. Region MUST match the website (asia-south1). Guests (anonymous) are refused inside core. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const core = require('./lib/core');

setGlobalOptions({ region: 'asia-south1', maxInstances: 10 });
admin.initializeApp();
const ctx = { db: admin.firestore(), FV: admin.firestore.FieldValue };

const h = (fn) => onCall({ cors: true, timeoutSeconds: 30, memory: '256MiB' }, async (req) => {
  try { return await core[fn](ctx, req.auth, req.data); } catch (e) {
    if (e instanceof core.CoreError) throw new HttpsError(e.code, e.message);
    console.error('connections.' + fn + ' failed', e); throw new HttpsError('internal', 'Something went wrong. Please try again.');
  }
});
exports.connSend = h('sendRequest');
exports.connRespond = h('respond');
exports.connCancel = h('cancelRequest');
exports.connRemove = h('removeConnection');
exports.connMutuals = h('mutuals');
exports.connSuggest = h('suggestions');
