'use strict';
/* ONE-OFF. Lists every EXISTING guest (and any other account) in Connect > People.

   Why: the app only writes publicProfiles/{uid} (the People list) when a user opens the app after your change. Guests who
   have not opened it since never got a doc, so they are missing. Their names are already stored in userProfiles/{uid}.name
   (the "name mirror"), so this copies name / year / branch from there.

   - Skips anyone who already has a publicProfiles doc (never overwrites a profile someone edited).
   - Skips uids that no longer exist in Firebase Auth (guests who logged out are erased for good, so they would be dead entries).
   - Skips profiles with no name. Username is NOT required and is not copied (the app adds it later if the user has one).
   Safe to re-run.

   Run from functions-account/ (it has firebase-admin installed) with Admin credentials:
     cd functions-account && npm install
     GOOGLE_APPLICATION_CREDENTIALS=key.json node ../scripts/backfill-guest-profiles.js --dry
     GOOGLE_APPLICATION_CREDENTIALS=key.json node ../scripts/backfill-guest-profiles.js */
const path = require('path');
const admin = require(path.join(process.cwd(), 'node_modules', 'firebase-admin'));
admin.initializeApp({ projectId: 'cse-c-hub' });
const db = admin.firestore(), auth = admin.auth(), FV = admin.firestore.FieldValue;
const dry = process.argv.includes('--dry');
const BR = ['CSE', 'CSEAIML', 'ISE', 'ECE', 'EEE', 'EI', 'CV', 'IP', 'ENV', 'BT', 'CTM', 'ME', 'PST', 'CSBS'];

(async () => {
  const profs = (await db.collection('userProfiles').select('name', 'year', 'branch', 'isGuest').get()).docs;
  const existing = new Set((await db.collection('publicProfiles').select().get()).docs.map((d) => d.id));

  // candidates: has a name, not already listed
  const cand = [];
  let noName = 0, already = 0;
  for (const d of profs) {
    const x = d.data(), name = String(x.name || '').trim().slice(0, 40);
    if (existing.has(d.id)) { already++; continue; }
    if (!name) { noName++; continue; }
    cand.push({ uid: d.id, name, year: String(x.year || ''), branch: String(x.branch || ''), guest: !!x.isGuest });
  }

  // keep only uids that still exist in Auth (getUsers accepts max 100 at a time)
  const alive = new Set();
  for (let i = 0; i < cand.length; i += 100) {
    const r = await auth.getUsers(cand.slice(i, i + 100).map((c) => ({ uid: c.uid })));
    r.users.forEach((u) => alive.add(u.uid));
  }

  let written = 0, gone = 0, guests = 0, batch = db.batch(), n = 0;
  for (const c of cand) {
    if (!alive.has(c.uid)) { gone++; continue; }
    const doc = { name: c.name, updatedAt: FV.serverTimestamp() };
    if (c.year === '1' || c.year === '2') doc.year = c.year;
    if (BR.includes(c.branch)) doc.branch = c.branch;
    written++; if (c.guest) guests++;
    if (dry) continue;
    batch.set(db.collection('publicProfiles').doc(c.uid), doc);
    if (++n === 400) { await batch.commit(); batch = db.batch(); n = 0; }
  }
  if (!dry && n) await batch.commit();
  console.log((dry ? '[dry run] ' : '') +
    `userProfiles: ${profs.length} | already listed: ${already} | no name: ${noName} | account gone from Auth: ${gone} | ` +
    `${dry ? 'would add' : 'added'}: ${written} (guests: ${guests})`);
})().catch((e) => { console.error(e); process.exit(1); });
