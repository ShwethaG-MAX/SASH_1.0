'use strict';
/* ONE-OFF cleanup for Connect > People: keeps ONE entry per name and removes the duplicate ones.

   Duplicates exist because every guest login / logout / cleared browser / new device creates a NEW anonymous account (new uid),
   and each one got its own publicProfiles doc.

   For every group of profiles with the same name (ignoring capitals and extra spaces) it keeps the best one:
     1. a real account (email / Google) beats a guest
     2. one with a username, photo, bio, skills or projects beats a plain one
     3. otherwise the most recently signed-in one wins
   It only DELETES a duplicate when that duplicate is "plain":
     - it is a guest account (or its account no longer exists in Auth), AND
     - it has no username, photo, bio, skills or projects, AND
     - it has no connections.
   Real accounts are never deleted, so two real students with the same name both stay.
   Only publicProfiles docs are removed; no Auth account or other data is touched.

   Run from functions-account/ with Admin credentials (same as the backfill):
     $env:GOOGLE_APPLICATION_CREDENTIALS="key.json"
     node ../scripts/dedupe-people.js --dry
     node ../scripts/dedupe-people.js */
const path = require('path');
const admin = require(path.join(process.cwd(), 'node_modules', 'firebase-admin'));
admin.initializeApp({ projectId: 'cse-c-hub' });
const db = admin.firestore(), auth = admin.auth();
const dry = process.argv.includes('--dry');
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const rich = (x) => !!(x.username || x.photo || x.photoUrl || x.coverUrl || String(x.bio || '').trim() ||
  (x.skills || []).length || (x.projects || []).length || (x.interests || []).length || x.headline);

(async () => {
  const docs = (await db.collection('publicProfiles').get()).docs;
  const info = {};   // uid -> {guest, last, gone}
  for (let i = 0; i < docs.length; i += 100) {
    const ids = docs.slice(i, i + 100).map((d) => ({ uid: d.id }));
    const r = await auth.getUsers(ids);
    r.users.forEach((u) => { info[u.uid] = { guest: !u.providerData.length, last: Date.parse(u.metadata.lastSignInTime || u.metadata.creationTime || 0) || 0 }; });
  }
  const groups = {};
  docs.forEach((d) => { const x = d.data(), k = norm(x.name); if (!k) return;
    const a = info[d.id] || { guest: true, last: 0, gone: true };
    (groups[k] = groups[k] || []).push({ id: d.id, ref: d.ref, x, guest: a.guest, gone: !!a.gone, last: a.last, rich: rich(x) }); });

  let dupGroups = 0, remove = [], keptReal = 0, skippedRich = 0, skippedConn = 0;
  for (const k of Object.keys(groups)) {
    const g = groups[k]; if (g.length < 2) continue; dupGroups++;
    g.sort((a, b) => (!b.guest - !a.guest) || (b.rich - a.rich) || (b.last - a.last));   // best first
    for (const c of g.slice(1)) {
      if (!c.guest && !c.gone) { keptReal++; continue; }       // never delete a real account
      if (c.rich) { skippedRich++; continue; }                 // has real profile content / username
      const conn = await db.collection('connections').where('users', 'array-contains', c.id).limit(1).get();
      if (!conn.empty) { skippedConn++; continue; }            // has connections
      remove.push(c);
    }
  }
  if (!dry) { for (let i = 0; i < remove.length; i += 400) { const b = db.batch(); remove.slice(i, i + 400).forEach((c) => b.delete(c.ref)); await b.commit(); } }
  console.log((dry ? '[dry run] ' : '') + `profiles: ${docs.length} | names with duplicates: ${dupGroups} | ` +
    `${dry ? 'would remove' : 'removed'}: ${remove.length} | kept (real accounts): ${keptReal} | kept (has profile content): ${skippedRich} | kept (has connections): ${skippedConn} | ` +
    `entries left: ${docs.length - remove.length}`);
})().catch((e) => { console.error(e); process.exit(1); });
