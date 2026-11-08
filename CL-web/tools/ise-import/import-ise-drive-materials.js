#!/usr/bin/env node
/**
 * Student Centro — import Google Drive study materials into Second Year · ISE.
 *
 * Writes to the EXISTING `studyMaterials` collection using the exact schema the app already uses
 * (title, url, subject = subject NAME, folder, resourceType, description, scope = 'SY-ISE', anonymousId, createdAt)
 * plus a few extra fields the app ignores (driveFileId, mimeType, drivePath, isDriveFolder, branch, year, importSource).
 *
 * SAFE BY DEFAULT:  dry-run unless you pass --apply.   Never updates or deletes existing documents.
 * Idempotent:       doc id = "drive_<DriveFileId>" and any existing doc whose driveFileId / URL already holds that id is skipped.
 *
 *   node import-ise-drive-materials.js --check                     # offline: validate the data file only (no Firebase needed)
 *   node import-ise-drive-materials.js --project <id>              # dry-run against Firestore (reads only)
 *   node import-ise-drive-materials.js --project <id> --apply      # really write
 *   node import-ise-drive-materials.js --project <id> --rollback --apply   # delete ONLY docs created by this import (importSource tag)
 *
 * Credentials: GOOGLE_APPLICATION_CREDENTIALS=<service-account.json>  (Admin SDK bypasses rules, so firestore.rules is unchanged).
 */
const fs = require('fs'), path = require('path');
const SOURCE = 'drive-inventory-ise-sy-2026-11';
const SCOPE = 'SY-ISE', ANON = 'drive-import', GENERAL = 'General Resources';
const SUBJECTS = ['Engineering Mathematics III','Computer Organization & Architecture','Discrete Mathematical Structures',
  'Data Structures and Applications','Object Oriented Programming Concepts','Operating Systems','Universal Human Values (UHV)-II']; // = SY_STUDY_SUBJECTS.ISE names in index.html
const args = process.argv.slice(2), has = f => args.includes(f), val = f => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : undefined; };
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'ise-sy-drive-materials.json'), 'utf8'));

function validate(items){
  const errs = [], seen = new Set();
  for(const it of items){
    // exact URLs from the inventory are kept untouched: Drive folder, Drive file (/view), or Google Slides link (.pptx opened as Slides)
    const m = it.type === 'Folder' ? /^https:\/\/drive\.google\.com\/drive\/folders\/([\w-]+)$/ : /^https:\/\/(?:drive\.google\.com\/file|docs\.google\.com\/(?:presentation|document|spreadsheets))\/d\/([\w-]+)\/(?:view|edit)\?/;
    const g = m.exec(it.url);
    if(!g) errs.push(`bad URL shape: ${it.name} -> ${it.url}`); else if(g[1] !== it.fileId) errs.push(`file id != URL id: ${it.name}`);
    if(seen.has(it.fileId)) errs.push(`duplicate file id: ${it.fileId}`); seen.add(it.fileId);
    if(!SUBJECTS.includes(it.subject)) errs.push(`unknown subject "${it.subject}" for ${it.name}`);
    if(!it.name || !it.name.trim()) errs.push(`empty name for ${it.fileId}`);
  }
  return errs;
}
function toDoc(it, createdAt){
  return { title: it.name, url: it.url, subject: it.subject, folder: it.folder || GENERAL, resourceType: it.resourceType,
    description: it.type === 'Folder' ? 'Google Drive folder — opens in Drive.' : (it.note ? 'Original Drive location: ' + it.drivePath + '.' : ''),
    scope: SCOPE, branch: 'ISE', year: '2', anonymousId: ANON, createdAt,
    driveFileId: it.fileId, mimeType: it.mimeType, drivePath: it.drivePath, isDriveFolder: it.type === 'Folder', importSource: SOURCE };
}
const idFromUrl = u => { const m = /\/d\/([\w-]+)|\/folders\/([\w-]+)/.exec(u || ''); return m ? (m[1] || m[2]) : null; };

(async () => {
  const errs = validate(data.items);
  const files = data.items.filter(i => i.type === 'File').length, folders = data.items.length - files;
  console.log(`Data file: ${data.items.length} items (${files} files + ${folders} folders) to import; ${data.held.length} held back (no subject).`);
  if(errs.length){ console.error('VALIDATION FAILED:\n' + errs.join('\n')); process.exit(1); }
  console.log('Validation OK: URLs match IDs, IDs unique, every subject exists in the ISE subject list.');
  if(has('--check')) return;

  const project = val('--project'); if(!project){ console.error('Pass --project <firebase-project-id> (or use --check).'); process.exit(1); }
  const { initializeApp, applicationDefault } = require('firebase-admin/app');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');
  initializeApp({ projectId: project, credential: applicationDefault() });
  const db = getFirestore(), col = db.collection('studyMaterials'), apply = has('--apply');
  console.log(`Project: ${project}   Mode: ${apply ? 'APPLY (writes!)' : 'DRY-RUN (read-only)'}${has('--rollback') ? '   ROLLBACK' : ''}`);

  if(has('--rollback')){
    const q = await col.where('importSource', '==', SOURCE).get();
    const del = q.docs.filter(d => d.id.startsWith('drive_'));
    console.log(`Rollback would delete ${del.length} docs created by this import.`);
    if(apply){ for(let i = 0; i < del.length; i += 400){ const b = db.batch(); del.slice(i, i+400).forEach(d => b.delete(d.ref)); await b.commit(); } console.log('Deleted.'); }
    return;
  }

  const snap = await col.get();
  const existing = new Map();           // drive id -> existing doc id
  snap.forEach(d => { const x = d.data(); [x.driveFileId, idFromUrl(x.url)].filter(Boolean).forEach(k => existing.set(k, d.id)); });
  console.log(`studyMaterials currently holds ${snap.size} documents.`);
  const todo = data.items.filter(it => !existing.has(it.fileId)), skipped = data.items.length - todo.length;
  console.log(`Already present (skipped, never overwritten): ${skipped}.  To insert: ${todo.length}.`);
  const total = snap.size + todo.length;
  if(total > 500) console.warn(`WARNING: the app's listener loads only the newest 500 studyMaterials docs; after import there would be ${total}. Oldest docs would stop showing. Raise .limit(500) in index.html first, or pass --allow-over-limit.`);
  if(total > 500 && !has('--allow-over-limit') && apply){ console.error('Aborting (nothing written).'); process.exit(2); }

  // first Drive row = newest createdAt, so the app's "newest first" order matches the Drive listing order
  const now = Date.now(), per = {};
  todo.forEach(it => { per[it.subject] = (per[it.subject] || 0) + 1; });
  console.table(per);
  if(!apply){ console.log('Dry-run complete. Re-run with --apply to write.'); return; }
  for(let i = 0; i < todo.length; i += 400){
    const b = db.batch();
    todo.slice(i, i+400).forEach(it => b.create(col.doc('drive_' + it.fileId), toDoc(it, Timestamp.fromMillis(now - it.order * 1000))));   // create() fails instead of overwriting
    await b.commit();
  }
  console.log(`Inserted ${todo.length} documents.`);
})().catch(e => { console.error(e); process.exit(1); });