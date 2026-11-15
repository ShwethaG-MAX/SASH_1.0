'use strict';
/* Admin access management. Admin = Firebase Auth custom claim owner:true (that is what firestore.rules isOwner() and the app check).
   Only the MAIN admin (an admin that was NOT delegated through this file) can give or remove admin access. Every delegated admin is recorded in
   adminGrants/{uid} (Admin SDK only: no client rule exists, so clients can never read or write it). `auth`, `db`, `FV` are injected for tests. */

class AdminError extends Error { constructor(code, message) { super(message); this.code = code; } }
const E = (code, msg) => new AdminError(code, msg);

const CR_DOMAIN = /@cr\.cse-hub\.app$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : 0));

/* Checks the caller against Auth NOW (not only their ID token): a token of an admin who was just removed stays valid for up to an hour. */
async function assertAdmin({ auth, db }, callerUid) {
  const user = await auth.getUser(callerUid);
  if (!user.customClaims || user.customClaims.owner !== true) throw E('permission-denied', 'Admin access required.');
  const g = await db.collection('adminGrants').doc(callerUid).get();
  return { user, delegated: g.exists };
}
async function assertMainAdmin(ctx, callerUid) {
  const a = await assertAdmin(ctx, callerUid);
  if (a.delegated) throw E('permission-denied', 'Only the main admin can give or remove admin access.');
  return a;
}

async function grantAdmin(ctx, callerUid, data) {
  const { auth, db, FV } = ctx;
  const email = String((data && data.email) || '').trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw E('invalid-argument', 'Enter a valid email address.');
  if (CR_DOMAIN.test(email)) throw E('failed-precondition', 'CR accounts cannot be made admins.');
  const { user: caller } = await assertMainAdmin(ctx, callerUid);

  let target;
  try { target = await auth.getUserByEmail(email); } catch (e) {
    if (e && e.code === 'auth/user-not-found') throw E('not-found', 'No Campus Loop account uses that email. Ask them to sign up first, then try again.');
    throw e;
  }
  const info = { uid: target.uid, email: target.email || email, name: target.displayName || '' };
  if (target.uid === callerUid) throw E('failed-precondition', 'You are already an admin.');
  if (target.disabled) throw E('failed-precondition', 'That account is disabled.');
  // Never hand admin to an email nobody has proven they own: anyone can register an unverified account with someone else's address.
  if (!target.emailVerified) throw E('failed-precondition', 'That email is not verified yet. Ask them to verify it (Settings → Resend verification email, or sign in with Google), then try again.');
  const claims = target.customClaims || {};
  if (claims.owner === true) return Object.assign({ status: 'already' }, info);
  if ((await db.collection('crAccounts').doc(target.uid).get()).exists) throw E('failed-precondition', 'That account is a CR account, so it cannot also be an admin.');

  const ref = db.collection('adminGrants').doc(target.uid);
  await ref.set({ email: info.email, name: info.name, grantedBy: callerUid, grantedByEmail: caller.email || '', grantedAt: FV.serverTimestamp() });   // record first: a granted admin must always be removable
  try { await auth.setCustomUserClaims(target.uid, Object.assign({}, claims, { owner: true })); } catch (e) { await ref.delete().catch(() => {}); throw e; }
  return Object.assign({ status: 'granted' }, info);
}

async function revokeAdmin(ctx, callerUid, data) {
  const { auth, db } = ctx;
  const uid = data && data.uid;
  if (typeof uid !== 'string' || !UID_RE.test(uid)) throw E('invalid-argument', 'Invalid account.');
  await assertMainAdmin(ctx, callerUid);
  if (uid === callerUid) throw E('failed-precondition', 'You cannot remove your own admin access.');
  const ref = db.collection('adminGrants').doc(uid);
  if (!(await ref.get()).exists) throw E('failed-precondition', 'Only admins added from this screen can be removed here.');   // the main admin is protected
  let user = null;
  try { user = await auth.getUser(uid); } catch (e) { if (!(e && e.code === 'auth/user-not-found')) throw e; }
  if (user) {
    const claims = Object.assign({}, user.customClaims || {}); delete claims.owner;
    await auth.setCustomUserClaims(uid, Object.keys(claims).length ? claims : null);
    await auth.revokeRefreshTokens(uid);      // their session ends the next time the app refreshes it
  }
  await ref.delete();
  return { status: 'removed', uid };
}

async function listAdmins(ctx, callerUid) {
  const { db } = ctx;
  const { delegated } = await assertAdmin(ctx, callerUid);
  const snap = await db.collection('adminGrants').orderBy('grantedAt', 'desc').limit(200).get();
  const admins = snap.docs.map((d) => { const x = d.data() || {}; return { uid: d.id, email: x.email || '', name: x.name || '', grantedByEmail: x.grantedByEmail || '', grantedAt: ms(x.grantedAt) }; });
  return { canManage: !delegated, admins };
}

module.exports = { AdminError, grantAdmin, revokeAdmin, listAdmins };