'use strict';
/* Pure + Firestore-parameterised logic for chat reports and moderation. `db` / `FV` / `Timestamp` are injected so tests can use a fake. */
const ROOMS = ['linklearn', 'year1', 'year2'];   // linklearn = Global Chat; year1/year2 = First/Second Year Community
const REASONS = ['harassment', 'abusive', 'spam', 'inappropriate', 'impersonation', 'other'];
const STATUSES = ['pending', 'reviewed', 'resolved'];
const ACTIONS = ['setStatus', 'warn', 'deleteMessage', 'restrict', 'unrestrict', 'dismiss'];
const RATE_LIMIT = 10, RATE_WINDOW_MS = 3600 * 1000, CONTEXT_COUNT = 5;

class CoreError extends Error { constructor(code, message) { super(message); this.code = code; } }   // index.js maps to HttpsError

const isRoom = (r) => typeof r === 'string' && ROOMS.includes(r);
const reportId = (room, messageId, reporterUid) => `${room}_${messageId}_${reporterUid}`;
const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : 0));

/* A restriction doc {rooms:[..], until:Timestamp|null} is active for `room` at `nowMs`. until null = until lifted. */
function restrictionActive(r, room, nowMs) {
  if (!r || !Array.isArray(r.rooms) || !r.rooms.includes(room)) return false;
  if (r.until == null) return true;
  return ms(r.until) > nowMs;
}

function validateReportInput(d) {
  d = d || {};
  if (!isRoom(d.room)) throw new CoreError('invalid-argument', 'Unknown community.');
  if (!validId(d.messageId)) throw new CoreError('invalid-argument', 'Missing message.');
  if (!REASONS.includes(d.reason)) throw new CoreError('invalid-argument', 'Please choose a reason.');
  return { room: d.room, messageId: d.messageId, reason: d.reason, details: cleanText(d.details, 500) };
}

async function profileOf(db, uid) {
  try {
    const s = await db.collection('userProfiles').doc(uid).get();
    const p = s.exists ? s.data() : {};
    return { name: cleanText(p.name, 40), branch: cleanText(p.branch, 20), year: cleanText(p.year, 4) };
  } catch (e) { return { name: '', branch: '', year: '' }; }
}

/* Up to CONTEXT_COUNT messages posted before the reported one, same room only (path-scoped), oldest first. */
async function buildContext(db, room, msg, msgId) {
  const col = db.collection('chatRooms').doc(room).collection('messages');
  let docs = [];
  try { docs = (await col.orderBy('createdAt', 'desc').where('createdAt', '<=', msg.createdAt).limit(CONTEXT_COUNT + 3).get()).docs; } catch (e) { docs = []; }
  return docs.filter((d) => d.id !== msgId).slice(0, CONTEXT_COUNT).reverse().map((d) => {
    const m = d.data();
    return { id: d.id, uid: m.anonymousId || '', text: cleanText(m.message, 300), createdAtMs: ms(m.createdAt) };
  });
}

async function createReport({ db, FV, nowMs }, uid, input) {
  const v = validateReportInput(input);
  const msgRef = db.collection('chatRooms').doc(v.room).collection('messages').doc(v.messageId);
  const msgSnap = await msgRef.get();
  if (!msgSnap.exists) throw new CoreError('not-found', 'That message is no longer available.');
  const msg = msgSnap.data();
  if (msg.anonymousId === uid) throw new CoreError('failed-precondition', 'You can’t report your own message.');
  const id = reportId(v.room, v.messageId, uid);
  const repRef = db.collection('chatReports').doc(id);
  if ((await repRef.get()).exists) throw new CoreError('already-exists', 'You have already reported this message. Thank you — a moderator will review it.');
  /* rolling-hour rate limit per reporter */
  const mine = await db.collection('chatReports').where('reporterUid', '==', uid).where('createdAtMs', '>=', nowMs - RATE_WINDOW_MS).limit(RATE_LIMIT + 1).get();
  if (mine.docs.length >= RATE_LIMIT) throw new CoreError('resource-exhausted', 'You have sent many reports recently. Please try again later.');
  const [reported, reporter, context] = await Promise.all([profileOf(db, msg.anonymousId), profileOf(db, uid), buildContext(db, v.room, msg, v.messageId)]);
  const doc = {
    room: v.room, messageId: v.messageId,
    reportedUid: msg.anonymousId || '', reportedName: reported.name, reportedBranch: reported.branch, reportedYear: reported.year,
    reporterUid: uid, reporterName: reporter.name,
    reason: v.reason, details: v.details,
    messageText: cleanText(msg.message, 1000), messageHasMedia: !!(msg.type || msg.path), messageCreatedAtMs: ms(msg.createdAt),
    context, createdAt: FV.serverTimestamp(), createdAtMs: nowMs,
    status: 'pending', reviewedBy: null, reviewedAt: null, lastAction: null, messageDeleted: false,
  };
  try { await repRef.create(doc); } catch (e) {
    if (e && (e.code === 6 || e.code === 'already-exists')) throw new CoreError('already-exists', 'You have already reported this message. Thank you — a moderator will review it.');
    throw e;
  }
  return { ok: true, reportId: id };
}

function validateModerateInput(d) {
  d = d || {};
  if (typeof d.reportId !== 'string' || !/^[A-Za-z0-9_-]{1,300}$/.test(d.reportId)) throw new CoreError('invalid-argument', 'Missing report.');
  if (!ACTIONS.includes(d.action)) throw new CoreError('invalid-argument', 'Unknown moderation action.');
  const o = { reportId: d.reportId, action: d.action, note: cleanText(d.note, 300) };
  if (d.action === 'setStatus') {
    if (!STATUSES.includes(d.status)) throw new CoreError('invalid-argument', 'Invalid status.');
    o.status = d.status;
  }
  if (d.action === 'warn') {
    o.text = cleanText(d.text, 300);
    if (!o.text) throw new CoreError('invalid-argument', 'Write the warning text.');
  }
  if (d.action === 'restrict') {
    const h = Number(d.hours);
    if (!Number.isInteger(h) || h < 0 || h > 8760) throw new CoreError('invalid-argument', 'Hours must be 0 (until lifted) to 8760.');
    if (d.scope !== 'room' && d.scope !== 'both') throw new CoreError('invalid-argument', 'Scope must be room or both.');
    o.hours = h; o.scope = d.scope;
  }
  if (d.action === 'unrestrict') o.scope = d.scope === 'both' ? 'both' : 'room';
  return o;
}

async function moderate({ db, FV, Timestamp, nowMs }, adminUid, input) {
  if (!input || typeof input.reportId !== 'string' || !input.reportId) throw new CoreError('invalid-argument', 'Missing report.');
  const v = validateModerateInput(input);
  const repRef = db.collection('chatReports').doc(v.reportId);
  const rep = await repRef.get();
  if (!rep.exists) throw new CoreError('not-found', 'Report not found.');
  const r = rep.data();
  const upd = { reviewedBy: adminUid, reviewedAt: FV.serverTimestamp() };
  let detail = {}, targetUid = r.reportedUid;

  if (v.action === 'setStatus') { upd.status = v.status; upd.lastAction = 'status:' + v.status; detail = { status: v.status }; }
  else if (v.action === 'dismiss') { upd.status = 'resolved'; upd.lastAction = 'dismissed'; }
  else if (v.action === 'warn') {
    await db.collection('chatWarnings').doc().set({ uid: r.reportedUid, room: r.room, text: v.text, createdAt: FV.serverTimestamp(), reportId: v.reportId });
    upd.status = r.status === 'pending' ? 'reviewed' : r.status; upd.lastAction = 'warned'; detail = { text: v.text };
  } else if (v.action === 'deleteMessage') {
    const col = db.collection('chatRooms').doc(r.room);   // path-scoped: can only ever touch THIS report's room
    const mRef = col.collection('messages').doc(r.messageId);
    const had = (await mRef.get()).exists;
    await mRef.delete();
    for (const sub of ['reactions', 'views']) {
      try { const s = await col.collection(sub).where('msgId', '==', r.messageId).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); } catch (e) { /* best effort */ }
    }
    upd.messageDeleted = true; upd.status = r.status === 'pending' ? 'reviewed' : r.status; upd.lastAction = 'message_deleted'; detail = { existed: had };
  } else if (v.action === 'restrict') {
    const rooms = v.scope === 'both' ? ROOMS.slice() : [r.room];
    const until = v.hours === 0 ? null : Timestamp.fromMillis(nowMs + v.hours * 3600 * 1000);
    const cur = await db.collection('chatRestrictions').doc(r.reportedUid).get();
    const prev = cur.exists ? cur.data() : null;
    const merged = Array.from(new Set(rooms.concat(...ROOMS.map((r) => (prev && restrictionActive(prev, r, nowMs) ? [r] : [])).flat())));
    await db.collection('chatRestrictions').doc(r.reportedUid).set({ rooms: merged, until, reason: v.note || r.reason, by: adminUid, createdAt: FV.serverTimestamp() });
    upd.status = r.status === 'pending' ? 'reviewed' : r.status; upd.lastAction = 'restricted'; detail = { rooms: merged, hours: v.hours };
  } else if (v.action === 'unrestrict') {
    const ref = db.collection('chatRestrictions').doc(r.reportedUid), cur = await ref.get();
    if (cur.exists) {
      const left = v.scope === 'both' ? [] : (cur.data().rooms || []).filter((x) => x !== r.room);
      if (left.length) await ref.set({ ...cur.data(), rooms: left }); else await ref.delete();
    }
    upd.lastAction = 'unrestricted'; detail = { scope: v.scope };
  }
  await repRef.update(upd);
  await db.collection('chatModerationLog').doc().set({
    reportId: v.reportId, room: r.room, action: v.action, targetUid, messageId: r.messageId, by: adminUid, note: v.note, createdAt: FV.serverTimestamp(), detail,
  });
  return { ok: true };
}

module.exports = { ROOMS, REASONS, STATUSES, ACTIONS, RATE_LIMIT, RATE_WINDOW_MS, CoreError, isRoom, reportId, cleanText, validId, restrictionActive, validateReportInput, validateModerateInput, buildContext, createReport, moderate };
