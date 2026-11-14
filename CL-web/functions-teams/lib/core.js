'use strict';
/* Team Building logic. `db` / `FV` are injected so tests can run on a fake Firestore.
   Clients NEVER write team data directly (firestore.rules: write = false); every change goes through these functions, which run in
   transactions so capacity, membership and request status can never get out of step. */

const LIM = { MAX_MEMBERS_MIN: 2, MAX_MEMBERS_MAX: 20, LEAD_MAX: 5, JOIN_MAX: 10, PENDING_OUT_MAX: 10, RETRY_AFTER_REJECT_MS: 3600 * 1000,
  NAME_MIN: 3, NAME_MAX: 50, PROJECT_MAX: 80, DESC_MAX: 600, RULES_MAX: 600, ELIG_MAX: 150, MSG_MAX: 200, SKILLS_MAX: 12, SKILL_LEN: 30 };

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
  const { db, FV } = ctx, v = validateTeam(data, false), me = await profileOf(db, uid);
  if (!me.hasName) throw E('failed-precondition', 'Finish your profile (name) before creating a team.');
  if (await teamCount(db, 'leaderUid', uid) >= LIM.LEAD_MAX) throw E('resource-exhausted', `You can lead at most ${LIM.LEAD_MAX} teams.`);
  const ref = db.collection('teams').doc();
  const team = Object.assign({}, v, { open: v.open !== false, leaderUid: uid, leaderName: me.name, memberUids: [uid], memberCount: 1, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
  const batch = db.batch();
  batch.create(ref, team);
  batch.create(ref.collection('members').doc(uid), { uid, name: me.name, branch: me.branch, year: me.year, role: 'leader', joinedAt: FV.serverTimestamp() });
  await batch.commit();
  return { teamId: ref.id };
}

async function updateTeam(ctx, uid, data) {
  const { db, FV } = ctx; data = data || {};
  const v = validateTeam(data, true);
  await db.runTransaction(async (tx) => {
    const { ref, t } = await mustTeam(tx, db, data.teamId); mustLead(t, uid);
    if (v.maxMembers !== undefined && v.maxMembers < t.memberCount) throw E('failed-precondition', `The team already has ${t.memberCount} members. Remove members before lowering the size.`);
    if (!Object.keys(v).length) throw E('invalid-argument', 'Nothing to update.');
    tx.update(ref, Object.assign({}, v, { updatedAt: FV.serverTimestamp() }));
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
  const reqs = await settleRequests(ctx, data.teamId, 'cancelled', { reason: 'team-deleted' });
  const b = db.batch(); info.members.forEach((m) => b.delete(db.collection('teams').doc(data.teamId).collection('members').doc(m))); await b.commit();
  const nb = db.batch(); reqs.forEach((r) => nb.create(db.collection('teamNotifs').doc(r.from).collection('items').doc(), { type: 'disbanded', teamId: data.teamId, teamName: info.name, fromName: '', read: false, createdAt: FV.serverTimestamp() })); await nb.commit();
  return { ok: true };
}

/* ---------------- join requests ---------------- */
async function sendRequest(ctx, uid, data) {
  const { db, FV, nowMs } = ctx; data = data || {};
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
    tx.set(rref, { teamId: data.teamId, teamName: t.name, from: uid, fromName: me.name, fromBranch: me.branch, fromYear: me.year, to: t.leaderUid, status: 'pending', message, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
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
    tx.update(rref, { status: 'cancelled', updatedAt: ctx.FV.serverTimestamp() });
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
    if (rs.data().status !== 'pending') throw E('failed-precondition', 'This request was already answered or withdrawn.');
    if (!data.accept) {
      tx.update(rref, { status: 'rejected', updatedAt: FV.serverTimestamp() });
      notify(db, FV, tx, data.from, { type: 'rejected', teamId: data.teamId, teamName: t.name, fromName: t.leaderName });
      return;
    }
    if (t.memberUids.includes(data.from)) { tx.update(rref, { status: 'accepted', updatedAt: FV.serverTimestamp() }); return; }
    if (t.memberCount >= t.maxMembers) throw E('failed-precondition', 'The team is full. Remove a member or raise the team size first.');
    tx.update(ref, { memberUids: t.memberUids.concat([data.from]), memberCount: t.memberCount + 1, updatedAt: FV.serverTimestamp() });
    tx.create(ref.collection('members').doc(data.from), { uid: data.from, name: joiner.name, branch: joiner.branch, year: joiner.year, role: 'member', joinedAt: FV.serverTimestamp() });
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
    if (rs.exists) tx.update(rref, { status: 'removed', updatedAt: FV.serverTimestamp() });
    notify(db, FV, tx, data.member, { type: 'removed', teamId: data.teamId, teamName: t.name, fromName: t.leaderName });
  });
  return { ok: true };
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
    if (rs.exists) tx.update(rref, { status: 'left', updatedAt: FV.serverTimestamp() });
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

module.exports = { LIM, CoreError, validateTeam, cleanSkills, profileOf, createTeam, updateTeam, deleteTeam, sendRequest, cancelRequest, decideRequest, removeMember, leaveTeam, transferLeader, reqId };
