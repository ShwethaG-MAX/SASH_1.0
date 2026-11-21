'use strict';
/* Team Building logic. `db` / `FV` are injected so tests can run on a fake Firestore.
   Clients NEVER write team data directly (firestore.rules: write = false); every change goes through these functions, which run in
   transactions so capacity, membership and request status can never get out of step. */

const LIM = { MAX_MEMBERS_MIN: 2, MAX_MEMBERS_MAX: 20, LEAD_MAX: 5, JOIN_MAX: 10, PENDING_OUT_MAX: 10, RETRY_AFTER_REJECT_MS: 3600 * 1000,
  NAME_MIN: 3, NAME_MAX: 50, PROJECT_MAX: 80, DESC_MAX: 600, RULES_MAX: 600, ELIG_MAX: 150, MSG_MAX: 200, SKILLS_MAX: 12, SKILL_LEN: 30, ROLE_MAX: 30, EMAIL_MAX: 100, WA_MAX: 120 };

class CoreError extends Error { constructor(code, message) { super(message); this.code = code; } }   // index.js maps to HttpsError
const E = (code, msg) => new CoreError(code, msg);

const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : 0));
const reqId = (teamId, uid) => `${teamId}_${uid}`;
const BRANCHES = ['CSE', 'CSEAIML', 'ISE', 'ECE', 'EEE', 'EI', 'CV', 'IP', 'ENV', 'BT', 'CTM', 'ME', 'PST', 'CSBS'];

function cleanSkills(a) {
  if (a == null) return [];
  if (!Array.isArray(a)) throw E('invalid-argument', 'Skills must be a list.');
  const seen = new Set(), out = [];
  for (const x of a) { const k = clean(x, LIM.SKILL_LEN); if (!k) continue; const l = k.toLowerCase(); if (seen.has(l)) continue; seen.add(l); out.push(k); }
  if (out.length > LIM.SKILLS_MAX) throw E('invalid-argument', `Choose at most ${LIM.SKILLS_MAX} skills.`);
  return out;
}

/* Optional contact details (applicant email / phone) and the team WhatsApp group link. Empty input means "none". */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, PHONE_RE = /^\+?\d{7,15}$/, WA_RE = /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]{8,}(\?\S*)?$/;
function cleanEmail(v) {
  const s = clean(v, 200); if (!s) return '';
  if (s.length > LIM.EMAIL_MAX || !EMAIL_RE.test(s)) throw E('invalid-argument', 'Enter a valid email address, or leave it blank.');
  return s;
}
function cleanPhone(v) {
  const s = String(v == null ? '' : v).replace(/[\s().-]/g, ''); if (!s) return '';
  if (!PHONE_RE.test(s)) throw E('invalid-argument', 'Enter a valid phone number (7 to 15 digits), or leave it blank.');
  return s;
}
function cleanWa(v) {
  const s = clean(v, 300); if (!s) return '';
  if (s.length > LIM.WA_MAX || !WA_RE.test(s)) throw E('invalid-argument', 'Enter a valid WhatsApp group invite link (https://chat.whatsapp.com/...), or leave it blank.');
  return s;
}
const SCRUB = { contactEmail: '', contactPhone: '' };   // wipe a person's contact details from a request once they are no longer a prospect or member

function validateTeam(d, partial) {
  d = d || {}; const o = {};
  if (!partial || d.name !== undefined) { o.name = clean(d.name, LIM.NAME_MAX); if (o.name.length < LIM.NAME_MIN) throw E('invalid-argument', `Team name needs at least ${LIM.NAME_MIN} characters.`); o.nameLower = o.name.toLowerCase(); }
  if (!partial || d.project !== undefined) o.project = clean(d.project, LIM.PROJECT_MAX);
  if (!partial || d.desc !== undefined) { o.desc = clean(d.desc, LIM.DESC_MAX); if (!partial && !o.desc) throw E('invalid-argument', 'Add a short description of what the team is building.'); }
  if (!partial || d.skills !== undefined) o.skills = cleanSkills(d.skills);
  if (!partial || d.eligibility !== undefined) o.eligibility = clean(d.eligibility, LIM.ELIG_MAX);
  if (!partial || d.rules !== undefined) o.rules = clean(d.rules, LIM.RULES_MAX);
  if (!partial || d.maxMembers !== undefined) {
    const n = Number(d.maxMembers);
    if (!Number.isInteger(n) || n < LIM.MAX_MEMBERS_MIN || n > LIM.MAX_MEMBERS_MAX) throw E('invalid-argument', `Team size must be between ${LIM.MAX_MEMBERS_MIN} and ${LIM.MAX_MEMBERS_MAX}.`);
    o.maxMembers = n;
  }
  if (d.open !== undefined) o.open = d.open === true;
  return o;
}

async function profileOf(db, uid) {
  let name = '', branch = '', year = '';
  try { const s = await db.collection('publicProfiles').doc(uid).get(); if (s.exists) { const p = s.data(); name = clean(p.name, 40); branch = clean(p.branch, 20); year = clean(p.year, 4); } } catch (e) { /* fall through */ }
  if (!name) { try { const s = await db.collection('userProfiles').doc(uid).get(); if (s.exists) { const p = s.data(); name = clean(p.name, 40); branch = branch || clean(p.branch, 20); year = year || clean(p.year, 4); } } catch (e) { /* fall through */ } }
  if (!BRANCHES.includes(branch)) branch = '';
  if (year !== '1' && year !== '2') year = '';
  return { name: name || 'Student', branch, year, hasName: !!name };
}

const notify = (db, FV, tx, to, n) => tx.create(db.collection('teamNotifs').doc(to).collection('items').doc(), Object.assign({ read: false, createdAt: FV.serverTimestamp() }, n));

async function teamCount(db, field, uid) { return (await db.collection('teams').where(field, field === 'memberUids' ? 'array-contains' : '==', uid).get()).size; }

async function mustTeam(tx, db, teamId) {
  if (!validId(teamId)) throw E('invalid-argument', 'Unknown team.');
  const ref = db.collection('teams').doc(teamId), s = await tx.get(ref);
  if (!s.exists) throw E('not-found', 'This team no longer exists.');
  return { ref, t: s.data() };
}
const mustLead = (t, uid) => { if (t.leaderUid !== uid) throw E('permission-denied', 'Only the team leader can do this.'); };

/* ---------------- create / update / delete ---------------- */
async function createTeam(ctx, uid, data) {
  const { db, FV } = ctx, v = validateTeam(data, false), wa = cleanWa((data || {}).whatsappLink), me = await profileOf(db, uid);
  if (!me.hasName) throw E('failed-precondition', 'Finish your profile (name) before creating a team.');
  if (await teamCount(db, 'leaderUid', uid) >= LIM.LEAD_MAX) throw E('resource-exhausted', `You can lead at most ${LIM.LEAD_MAX} teams.`);
  const ref = db.collection('teams').doc();
  const team = Object.assign({}, v, { open: v.open !== false, leaderUid: uid, leaderName: me.name, memberUids: [uid], memberCount: 1, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
  const batch = db.batch();
  batch.create(ref, team);
  batch.create(ref.collection('members').doc(uid), { uid, name: me.name, branch: me.branch, year: me.year, role: 'leader', joinedAt: FV.serverTimestamp() });
  if (wa) batch.create(ref.collection('private').doc('info'), { whatsappLink: wa, updatedAt: FV.serverTimestamp() });   // members-only, never on the public team doc
  await batch.commit();
  return { teamId: ref.id };
}

async function updateTeam(ctx, uid, data) {
  const { db, FV } = ctx; data = data || {};
  const v = validateTeam(data, true), hasWa = data.whatsappLink !== undefined, wa = hasWa ? cleanWa(data.whatsappLink) : '';
  await db.runTransaction(async (tx) => {
    const { ref, t } = await mustTeam(tx, db, data.teamId); mustLead(t, uid);
    if (v.maxMembers !== undefined && v.maxMembers < t.memberCount) throw E('failed-precondition', `The team already has ${t.memberCount} members. Remove members before lowering the size.`);
    if (!Object.keys(v).length && !hasWa) throw E('invalid-argument', 'Nothing to update.');
    if (Object.keys(v).length) tx.update(ref, Object.assign({}, v, { updatedAt: FV.serverTimestamp() }));
    if (hasWa) {   // empty string removes the link
      const pref = ref.collection('private').doc('info');
      if (wa) tx.set(pref, { whatsappLink: wa, updatedAt: FV.serverTimestamp() }, { merge: true }); else tx.delete(pref);
    }
  });
  return { ok: true };
}

async function settleRequests(ctx, teamId, status, extra) {   // bulk-close pending requests of a team (batch, chunked)
  const { db, FV } = ctx, snap = await db.collection('teamRequests').where('teamId', '==', teamId).where('status', '==', 'pending').get();
  for (let i = 0; i < snap.docs.length; i += 400) {
    const b = db.batch();
    snap.docs.slice(i, i + 400).forEach((d) => { b.update(d.ref, Object.assign({ status, updatedAt: FV.serverTimestamp() }, extra || {})); });
    await b.commit();
  }
  return snap.docs.map((d) => d.data());
}

async function deleteTeam(ctx, uid, data) {
  const { db, FV } = ctx; data = data || {};
  const info = await db.runTransaction(async (tx) => {
    const { ref, t } = await mustTeam(tx, db, data.teamId); mustLead(t, uid);
    t.memberUids.filter((m) => m !== uid).forEach((m) => notify(db, FV, tx, m, { type: 'disbanded', teamId: data.teamId, teamName: t.name, fromName: t.leaderName }));
    tx.delete(ref);
    return { name: t.name, members: t.memberUids };
  });
  const reqs = await settleRequests(ctx, data.teamId, 'cancelled', Object.assign({ reason: 'team-deleted' }, SCRUB));
  const acc = await db.collection('teamRequests').where('teamId', '==', data.teamId).where('status', '==', 'accepted').get();   // accepted members' requests also hold contact details
  for (let i = 0; i < acc.docs.length; i += 400) { const ab = db.batch(); acc.docs.slice(i, i + 400).forEach((d) => ab.update(d.ref, SCRUB)); await ab.commit(); }
  const b = db.batch(); info.members.forEach((m) => b.delete(db.collection('teams').doc(data.teamId).collection('members').doc(m))); b.delete(db.collection('teams').doc(data.teamId).collection('private').doc('info')); await b.commit();
  const nb = db.batch(); reqs.forEach((r) => nb.create(db.collection('teamNotifs').doc(r.from).collection('items').doc(), { type: 'disbanded', teamId: data.teamId, teamName: info.name, fromName: '', read: false, createdAt: FV.serverTimestamp() })); await nb.commit();
  return { ok: true };
}

/* ---------------- join requests ---------------- */
async function sendRequest(ctx, uid, data) {
  const { db, FV, nowMs } = ctx; data = data || {};
  const contactEmail = cleanEmail(data.contactEmail), contactPhone = cleanPhone(data.contactPhone);
  const me = await profileOf(db, uid), message = clean(data.message, LIM.MSG_MAX);
  if (!me.hasName) throw E('failed-precondition', 'Finish your profile (name) before requesting to join a team.');
  if (await teamCount(db, 'memberUids', uid) >= LIM.JOIN_MAX) throw E('resource-exhausted', `You can be in at most ${LIM.JOIN_MAX} teams.`);
  if ((await db.collection('teamRequests').where('from', '==', uid).where('status', '==', 'pending').get()).size >= LIM.PENDING_OUT_MAX) throw E('resource-exhausted', `You have ${LIM.PENDING_OUT_MAX} requests waiting. Cancel one first.`);
  await db.runTransaction(async (tx) => {
    const { t } = await mustTeam(tx, db, data.teamId);
    if (t.memberUids.includes(uid)) throw E('already-exists', 'You are already in this team.');
    if (t.open === false) throw E('failed-precondition', 'This team is not accepting requests right now.');
    if (t.memberCount >= t.maxMembers) throw E('failed-precondition', 'This team is full.');
    const rref = db.collection('teamRequests').doc(reqId(data.teamId, uid)), rs = await tx.get(rref);
    if (rs.exists) {
      const r = rs.data();
      if (r.status === 'pending') throw E('already-exists', 'You already sent a request to this team.');
      if (r.status === 'rejected' && nowMs - ms(r.updatedAt) < LIM.RETRY_AFTER_REJECT_MS) throw E('failed-precondition', 'This team declined your request recently. Try again later.');
    }
    tx.set(rref, { teamId: data.teamId, teamName: t.name, from: uid, fromName: me.name, fromBranch: me.branch, fromYear: me.year, to: t.leaderUid, status: 'pending', message, contactEmail, contactPhone, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
    notify(db, FV, tx, t.leaderUid, { type: 'request', teamId: data.teamId, teamName: t.name, fromUid: uid, fromName: me.name });
  });
  return { ok: true };
}

async function cancelRequest(ctx, uid, data) {
  const { db } = ctx; data = data || {};
  if (!validId(data.teamId)) throw E('invalid-argument', 'Unknown team.');
  await db.runTransaction(async (tx) => {
    const rref = db.collection('teamRequests').doc(reqId(data.teamId, uid)), rs = await tx.get(rref);
    if (!rs.exists) throw E('not-found', 'Request not found.');
    if (rs.data().status !== 'pending') throw E('failed-precondition', 'This request was already answered.');
    tx.update(rref, Object.assign({ status: 'cancelled', updatedAt: ctx.FV.serverTimestamp() }, SCRUB));
  });
  return { ok: true };
}

async function decideRequest(ctx, uid, data) {
  const { db, FV } = ctx; data = data || {};
  if (!validId(data.teamId) || !validId(data.from)) throw E('invalid-argument', 'Unknown request.');
  if (data.accept !== true && data.accept !== false) throw E('invalid-argument', 'Choose accept or reject.');
  const joiner = data.accept ? await profileOf(db, data.from) : null;
  await db.runTransaction(async (tx) => {
    const { ref, t } = await mustTeam(tx, db, data.teamId); mustLead(t, uid);
    const rref = db.collection('teamRequests').doc(reqId(data.teamId, data.from)), rs = await tx.get(rref);
    if (!rs.exists) throw E('not-found', 'Request not found.');
    const req = rs.data();
    if (req.status !== 'pending') throw E('failed-precondition', 'This request was already answered or withdrawn.');
    if (!data.accept) {
      tx.update(rref, Object.assign({ status: 'rejected', updatedAt: FV.serverTimestamp() }, SCRUB));
      notify(db, FV, tx, data.from, { type: 'rejected', teamId: data.teamId, teamName: t.name, fromName: t.leaderName });
      return;
    }
    if (t.memberUids.includes(data.from)) { tx.update(rref, { status: 'accepted', updatedAt: FV.serverTimestamp() }); return; }
    if (t.memberCount >= t.maxMembers) throw E('failed-precondition', 'The team is full. Remove a member or raise the team size first.');
    tx.update(ref, { memberUids: t.memberUids.concat([data.from]), memberCount: t.memberCount + 1, updatedAt: FV.serverTimestamp() });
    tx.create(ref.collection('members').doc(data.from), { uid: data.from, name: joiner.name, branch: joiner.branch, year: joiner.year, role: 'member', email: String(req.contactEmail || ''), phone: String(req.contactPhone || ''), joinedAt: FV.serverTimestamp() });   // contact details are copied only into the members-only doc
    tx.update(rref, { status: 'accepted', updatedAt: FV.serverTimestamp() });
    notify(db, FV, tx, data.from, { type: 'accepted', teamId: data.teamId, teamName: t.name, fromName: t.leaderName });
  });
  return { ok: true };
}

/* ---------------- members ---------------- */
async function removeMember(ctx, uid, data) {
  const { db, FV } = ctx; data = data || {};
  if (!validId(data.member)) throw E('invalid-argument', 'Unknown member.');
  await db.runTransaction(async (tx) => {
    const { ref, t } = await mustTeam(tx, db, data.teamId); mustLead(t, uid);
    if (data.member === uid) throw E('invalid-argument', 'Use Leave Team, or transfer leadership first.');
    if (!t.memberUids.includes(data.member)) throw E('not-found', 'That student is not in this team.');
    const rref = db.collection('teamRequests').doc(reqId(data.teamId, data.member)), rs = await tx.get(rref);   // a former leader has no request doc
    tx.update(ref, { memberUids: t.memberUids.filter((m) => m !== data.member), memberCount: t.memberCount - 1, updatedAt: FV.serverTimestamp() });
    tx.delete(ref.collection('members').doc(data.member));
    if (rs.exists) tx.update(rref, Object.assign({ status: 'removed', updatedAt: FV.serverTimestamp() }, SCRUB));
    notify(db, FV, tx, data.member, { type: 'removed', teamId: data.teamId, teamName: t.name, fromName: t.leaderName });
  });
  return { ok: true };
}

/* The leader gives a member (or themselves) a working role such as "Frontend Developer" or a custom one. Empty text clears it.
   Stored as `title` on the member doc; the existing `role` field (leader / member) is untouched. */
async function setMemberRole(ctx, uid, data) {
  const { db, FV } = ctx; data = data || {};
  if (!validId(data.member)) throw E('invalid-argument', 'Unknown member.');
  const title = clean(data.title, LIM.ROLE_MAX);
  await db.runTransaction(async (tx) => {
    const { ref, t } = await mustTeam(tx, db, data.teamId); mustLead(t, uid);
    if (!t.memberUids.includes(data.member)) throw E('not-found', 'That student is not in this team.');
    tx.update(ref.collection('members').doc(data.member), { title });
  });
  return { ok: true, title };
}

async function leaveTeam(ctx, uid, data) {
  const { db, FV } = ctx; data = data || {};
  const me = await profileOf(db, uid);
  await db.runTransaction(async (tx) => {
    const { ref, t } = await mustTeam(tx, db, data.teamId);
    if (!t.memberUids.includes(uid)) throw E('failed-precondition', 'You are not in this team.');
    if (t.leaderUid === uid) throw E('failed-precondition', 'You lead this team. Transfer leadership to a member first, or delete the team.');
    const rref = db.collection('teamRequests').doc(reqId(data.teamId, uid)), rs = await tx.get(rref);   // a former leader has no request doc
    tx.update(ref, { memberUids: t.memberUids.filter((m) => m !== uid), memberCount: t.memberCount - 1, updatedAt: FV.serverTimestamp() });
    tx.delete(ref.collection('members').doc(uid));
    if (rs.exists) tx.update(rref, Object.assign({ status: 'left', updatedAt: FV.serverTimestamp() }, SCRUB));
    notify(db, FV, tx, t.leaderUid, { type: 'left', teamId: data.teamId, teamName: t.name, fromUid: uid, fromName: me.name });
  });
  return { ok: true };
}

async function transferLeader(ctx, uid, data) {
  const { db, FV } = ctx; data = data || {};
  if (!validId(data.member)) throw E('invalid-argument', 'Unknown member.');
  const target = await profileOf(db, data.member), mine = await profileOf(db, uid);
  if (await teamCount(db, 'leaderUid', data.member) >= LIM.LEAD_MAX) throw E('resource-exhausted', 'That member already leads the maximum number of teams.');
  await db.runTransaction(async (tx) => {
    const { ref, t } = await mustTeam(tx, db, data.teamId); mustLead(t, uid);
    if (data.member === uid || !t.memberUids.includes(data.member)) throw E('invalid-argument', 'Choose another member of this team.');
    tx.update(ref, { leaderUid: data.member, leaderName: target.name, updatedAt: FV.serverTimestamp() });
    tx.update(ref.collection('members').doc(uid), { role: 'member' });
    tx.update(ref.collection('members').doc(data.member), { role: 'leader' });
    notify(db, FV, tx, data.member, { type: 'transferred', teamId: data.teamId, teamName: t.name, fromName: mine.name });
  });
  const snap = await db.collection('teamRequests').where('teamId', '==', data.teamId).where('status', '==', 'pending').get();   // pending requests now belong to the new leader
  if (snap.docs.length) { const b = db.batch(); snap.docs.forEach((d) => b.update(d.ref, { to: data.member })); await b.commit(); }
  return { ok: true };
}

/* ---------------- invites (leader -> a specific student from Find people) ---------------- */
async function inviteSend(ctx, uid, data) {
  const { db, FV, nowMs } = ctx; data = data || {};
  if (!validId(data.teamId) || !validId(data.to)) throw E('invalid-argument', 'Unknown student or team.');
  if (data.to === uid) throw E('invalid-argument', 'You cannot invite yourself.');
  const leader = await profileOf(db, uid), invitee = await profileOf(db, data.to), message = clean(data.message, LIM.MSG_MAX);
  if (!invitee.hasName) throw E('failed-precondition', 'This student has not finished their profile yet.');
  if (await teamCount(db, 'memberUids', data.to) >= LIM.JOIN_MAX) throw E('resource-exhausted', 'This student is already in the maximum number of teams.');
  if ((await db.collection('teamInvites').where('from', '==', uid).where('status', '==', 'pending').get()).size >= 30) throw E('resource-exhausted', 'You have 30 invitations waiting. Cancel some first.');
  await db.runTransaction(async (tx) => {
    const { t } = await mustTeam(tx, db, data.teamId); mustLead(t, uid);
    if (t.memberUids.includes(data.to)) throw E('already-exists', 'This student is already in your team.');
    if (t.memberCount >= t.maxMembers) throw E('failed-precondition', 'Your team is full.');
    const iref = db.collection('teamInvites').doc(reqId(data.teamId, data.to)), is = await tx.get(iref);
    const rs = await tx.get(db.collection('teamRequests').doc(reqId(data.teamId, data.to)));
    if (is.exists) {
      const r = is.data();
      if (r.status === 'pending') throw E('already-exists', 'You already invited this student.');
      if (r.status === 'declined' && nowMs - ms(r.updatedAt) < LIM.RETRY_AFTER_REJECT_MS) throw E('failed-precondition', 'This student declined recently. Try again later.');
    }
    if (rs.exists && rs.data().status === 'pending') throw E('already-exists', 'This student already asked to join. Accept their request in Manage.');
    tx.set(iref, { teamId: data.teamId, teamName: t.name, from: uid, fromName: leader.name, to: data.to, toName: invitee.name, status: 'pending', message, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
    notify(db, FV, tx, data.to, { type: 'invite', teamId: data.teamId, teamName: t.name, fromUid: uid, fromName: leader.name });
  });
  return { ok: true };
}

async function inviteCancel(ctx, uid, data) {
  const { db, FV } = ctx; data = data || {};
  if (!validId(data.teamId) || !validId(data.to)) throw E('invalid-argument', 'Unknown invitation.');
  await db.runTransaction(async (tx) => {
    const iref = db.collection('teamInvites').doc(reqId(data.teamId, data.to)), s = await tx.get(iref);
    if (!s.exists || s.data().from !== uid) throw E('not-found', 'Invitation not found.');
    if (s.data().status !== 'pending') throw E('failed-precondition', 'This invitation was already answered.');
    tx.update(iref, { status: 'cancelled', updatedAt: FV.serverTimestamp() });
  });
  return { ok: true };
}

async function inviteDecide(ctx, uid, data) {
  const { db, FV } = ctx; data = data || {};
  if (!validId(data.teamId)) throw E('invalid-argument', 'Unknown invitation.');
  if (data.accept !== true && data.accept !== false) throw E('invalid-argument', 'Choose accept or decline.');
  const me = data.accept ? await profileOf(db, uid) : null;
  if (data.accept && await teamCount(db, 'memberUids', uid) >= LIM.JOIN_MAX) throw E('resource-exhausted', `You can be in at most ${LIM.JOIN_MAX} teams.`);
  await db.runTransaction(async (tx) => {
    const { ref, t } = await mustTeam(tx, db, data.teamId);
    const iref = db.collection('teamInvites').doc(reqId(data.teamId, uid)), is = await tx.get(iref);
    if (!is.exists) throw E('not-found', 'Invitation not found.');
    if (is.data().status !== 'pending') throw E('failed-precondition', 'This invitation was already answered or withdrawn.');
    const rref = db.collection('teamRequests').doc(reqId(data.teamId, uid)), rs = await tx.get(rref);
    if (!data.accept) {
      tx.update(iref, { status: 'declined', updatedAt: FV.serverTimestamp() });
      notify(db, FV, tx, t.leaderUid, { type: 'inviteDeclined', teamId: data.teamId, teamName: t.name, fromUid: uid, fromName: (is.data().toName || 'A student') });
      return;
    }
    if (t.memberUids.includes(uid)) { tx.update(iref, { status: 'accepted', updatedAt: FV.serverTimestamp() }); return; }
    if (t.memberCount >= t.maxMembers) throw E('failed-precondition', 'This team is full now.');
    tx.update(ref, { memberUids: t.memberUids.concat([uid]), memberCount: t.memberCount + 1, updatedAt: FV.serverTimestamp() });
    tx.create(ref.collection('members').doc(uid), { uid, name: me.name, branch: me.branch, year: me.year, role: 'member', email: '', phone: '', joinedAt: FV.serverTimestamp() });
    tx.update(iref, { status: 'accepted', updatedAt: FV.serverTimestamp() });
    if (rs.exists && rs.data().status === 'pending') tx.update(rref, Object.assign({ status: 'accepted', updatedAt: FV.serverTimestamp() }, SCRUB));   // they also asked to join: close that request too
    notify(db, FV, tx, t.leaderUid, { type: 'inviteAccepted', teamId: data.teamId, teamName: t.name, fromUid: uid, fromName: me.name });
  });
  return { ok: true };
}

/* ---------------- deadline / start reminders (scheduled) ----------------
   For every registered event whose registration deadline (dlAt) or start (startAt) is within 72 h (then again within 24 h), every member of the
   team gets ONE notification per (registration, kind, window). The notification id is deterministic, so re-running never duplicates it. */
const REMIND_WINDOWS_H = [24, 72];
async function sendDeadlineReminders(ctx) {
  const { db, FV, nowMs } = ctx; let sent = 0; const teams = {};
  const snap = await db.collection('eventRegistrations').where('endAt', '>=', nowMs).limit(500).get();
  for (const doc of snap.docs) {
    const r = doc.data(), targets = [['deadline', r.dlAt], ['start', r.startAt]].filter((p) => typeof p[1] === 'number' && p[1] > nowMs);
    if (!targets.length || !validId(r.teamId)) continue;
    if (teams[r.teamId] === undefined) { const ts = await db.collection('teams').doc(r.teamId).get(); teams[r.teamId] = ts.exists ? ts.data() : null; }
    const t = teams[r.teamId]; if (!t || !Array.isArray(t.memberUids)) continue;
    for (const [kind, when] of targets) {
      const left = when - nowMs, hrs = REMIND_WINDOWS_H.find((h) => left <= h * 3600e3); if (!hrs) continue;
      for (const m of t.memberUids) {
        const id = `rem_${doc.id}_${kind}_${hrs}_${m}`.slice(0, 300);
        try {
          await db.collection('teamNotifs').doc(m).collection('items').doc(id).create({ type: 'reminder', kind, teamId: r.teamId, teamName: t.name || r.teamName || '', eventTitle: String(r.eventTitle || ''), whenMs: when, hoursLeft: hrs, fromName: '', read: false, createdAt: FV.serverTimestamp() });
          sent++;
        } catch (e) { if (!(e && (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message))))) throw e; }
      }
    }
  }
  return { sent };
}

/* ---------------- phone push text (FCM) ----------------
   Only the NEW notification types are pushed from here (invites + reminders); request / accepted / rejected pushes already come from the Worker. */
const PUSH_TYPES = ['invite', 'inviteAccepted', 'inviteDeclined', 'reminder'];
function pushText(n) {
  n = n || {}; const t = n.teamName || 'a team', f = n.fromName || 'Someone';
  if (n.type === 'invite') return { title: '\uD83E\uDD1D Team invitation', body: `${f} invited you to join ${t}. Tap to accept or decline.` };
  if (n.type === 'inviteAccepted') return { title: '\uD83C\uDF89 Invite accepted', body: `${f} joined ${t}.` };
  if (n.type === 'inviteDeclined') return { title: 'Invite declined', body: `${f} declined your invite to ${t}.` };
  if (n.type === 'reminder') {
    const h = n.hoursLeft || 24, when = h <= 24 ? 'within 24 hours' : 'within 3 days', ev = n.eventTitle || 'your hackathon';
    return n.kind === 'start' ? { title: '\u23F0 Hackathon starting soon', body: `${ev} (${t}) starts ${when}.` } : { title: '\u23F0 Deadline coming up', body: `Registration for ${ev} (${t}) closes ${when}.` };
  }
  return null;
}

module.exports = { PUSH_TYPES, pushText, inviteSend, inviteCancel, inviteDecide, sendDeadlineReminders, LIM, CoreError, cleanEmail, cleanPhone, cleanWa, validateTeam, cleanSkills, profileOf, createTeam, updateTeam, deleteTeam, sendRequest, cancelRequest, decideRequest, removeMember, setMemberRole, leaveTeam, transferLeader, reqId };