#!/usr/bin/env node
/**
 * Copy shared study materials from CSE 2nd year (scope 'SY') and ISE 2nd year (scope 'SY-ISE') into
 * CSE AIML 2nd year (scope 'SY-CSEAIML') inside the EXISTING `studyMaterials` collection.
 *
 *   CSE  Computer Organization / Digital System Design -> AIML Logic Design and Computer Organization
 *   CSE  Discrete Mathematics        + ISE Discrete Mathematical Structures -> AIML Discrete Mathematical Structures
 *   CSE  Engineering Mathematics     + ISE Engineering Mathematics III      -> AIML Engineering Mathematics-III
 *   CSE  Data Structures / OOP using C++ / Universal Human Values -> same-named AIML subject
 *   (AIML "Data Science using Python" has no CSE/ISE counterpart -> nothing copied)
 *
 * Dry-run by default. Only CREATES new docs (id "aimlcopy_<originalDocId>"); never updates/deletes existing docs. Re-runnable.
 * A doc whose URL already exists in the target AIML subject is skipped and reported (never silently dropped).
 *   node copy-cse-to-aiml.js --project <id>              # dry-run
 *   node copy-cse-to-aiml.js --project <id> --apply      # write
 *   node copy-cse-to-aiml.js --project <id> --rollback --apply   # delete ONLY docs created by this script
 */
const FROM = [   // [source scope, source subject name, AIML subject name]
  ['SY', 'Computer Organization', 'Logic Design and Computer Organization'],
  ['SY', 'Digital System Design', 'Logic Design and Computer Organization'],
  ['SY', 'Discrete Mathematics', 'Discrete Mathematical Structures'],
  ['SY-ISE', 'Discrete Mathematical Structures', 'Discrete Mathematical Structures'],
  ['SY', 'Engineering Mathematics', 'Engineering Mathematics-III'],
  ['SY-ISE', 'Engineering Mathematics III', 'Engineering Mathematics-III'],
  ['SY', 'Data Structures', 'Data Structures'],
  ['SY', 'Object Oriented Programming using C++', 'Object Oriented Programming using C++'],
  ['SY', 'Universal Human Values', 'Universal Human Values'],
];
const TO = 'SY-CSEAIML', TAG = 'copy-cse-to-aiml';
const args = process.argv.slice(2), has = f => args.includes(f), val = f => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : undefined; };
(async () => {
  const project = val('--project'); if(!project){ console.error('Pass --project <firebase-project-id>'); process.exit(1); }
  const { initializeApp, applicationDefault } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  initializeApp({ projectId: project, credential: applicationDefault() });
  const db = getFirestore(), col = db.collection('studyMaterials'), apply = has('--apply');
  console.log(`Project: ${project}   Mode: ${apply ? 'APPLY (writes!)' : 'DRY-RUN (read-only)'}`);
  if(has('--rollback')){
    const q = await col.where('importSource', '==', TAG).get();
    console.log(`Rollback would delete ${q.size} docs.`);
    if(apply){ for(let i = 0; i < q.docs.length; i += 400){ const b = db.batch(); q.docs.slice(i, i+400).forEach(d => b.delete(d.ref)); await b.commit(); } console.log('Deleted.'); }
    return;
  }
  const snap = await col.get(), have = new Set(snap.docs.map(d => d.id));
  const seenUrl = new Set();      // "targetSubject|url" already in AIML
  snap.docs.forEach(d => { const x = d.data(); if(x.scope === TO) seenUrl.add(x.subject + '|' + x.url); });
  const todo = [], dupes = [], perTarget = {};
  for(const [sc, sub, target] of FROM){
    snap.docs.filter(d => { const x = d.data(); return (x.scope || 'SY') === sc && x.subject === sub; })
      .sort((a, b) => (a.data().createdAt?.toMillis?.() || 0) - (b.data().createdAt?.toMillis?.() || 0))
      .forEach(d => {
        const x = d.data(), id = 'aimlcopy_' + d.id;
        if(have.has(id)) return;                                   // copied on an earlier run
        const key = target + '|' + x.url;
        if(seenUrl.has(key)){ dupes.push(`${target}: "${x.title}" (${sc}/${sub}) same URL already present`); return; }
        seenUrl.add(key);
        todo.push({ id, from: d.id, data: x, target, sc });
        perTarget[`${target}  <=  ${sc} / ${sub}`] = (perTarget[`${target}  <=  ${sc} / ${sub}`] || 0) + 1;
      });
  }
  console.log(`studyMaterials: ${snap.size} docs.  To copy: ${todo.length}.  Same-URL duplicates skipped: ${dupes.length}.`);
  console.table(perTarget);
  dupes.forEach(l => console.log('  DUP  ' + l));
  if(snap.size + todo.length > 500) console.warn(`WARNING: the app loads only the newest 500 studyMaterials docs; total would be ${snap.size + todo.length}. Raise .limit(500) in index.html first, or pass --allow-over-limit.`);
  if(snap.size + todo.length > 500 && apply && !has('--allow-over-limit')){ console.error('Aborting (nothing written).'); process.exit(2); }
  if(!apply){ console.log('Dry-run complete. Re-run with --apply to write.'); return; }
  for(let i = 0; i < todo.length; i += 400){
    const b = db.batch();
    todo.slice(i, i + 400).forEach(t => {
      const { driveFileId, ...rest } = t.data;                      // keep the original id only as info, so the ISE importer never mistakes a copy for the original
      b.create(col.doc(t.id), { ...rest, subject: t.target, scope: TO, ...(rest.branch ? { branch: 'CSEAIML' } : {}),
        ...(driveFileId ? { sourceDriveFileId: driveFileId } : {}), copiedFrom: t.from, copiedFromScope: t.sc, importSource: TAG });   // create() never overwrites
    });
    await b.commit();
  }
  console.log(`Copied ${todo.length} documents.`);
})().catch(e => { console.error(e); process.exit(1); });