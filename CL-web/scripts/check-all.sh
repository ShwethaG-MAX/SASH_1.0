#!/usr/bin/env bash
# Offline validation for the whole project. Run from the project root:  bash scripts/check-all.sh
# Needs Node 22 and `npm install` already run in functions-syllabus/, functions-discover/ and functions-test/
# (functions-test needs it for the real PDF/DOCX round-trip tests; without it those two are reported as SKIPPED, everything else still runs).
# Does NOT touch Firebase and needs no credentials or network.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== JSON files"
for f in firebase.json firestore.indexes.json functions-*/package.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "ok  $f"; done
echo "== JavaScript syntax (functions)"
find functions-* scripts -name '*.js' -not -path '*/node_modules/*' -print0 | while IFS= read -r -d '' f; do node --check "$f" && echo "ok  $f"; done
echo "== JavaScript syntax (inline scripts in public/index.html)"
node -e "
const fs=require('fs'),cp=require('child_process'),os=require('os'),path=require('path');
const h=fs.readFileSync('public/index.html','utf8');let n=0;
for(const m of h.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)){
  if(/\bsrc=/.test(m[1])||!m[2].trim())continue;n++;
  const p=path.join(os.tmpdir(),'inline-'+n+'.js');fs.writeFileSync(p,m[2]);
  const r=cp.spawnSync(process.execPath,['--check',p],{encoding:'utf8'});
  if(r.status){console.error('SYNTAX ERROR in inline script #'+n+'\n'+r.stderr);process.exit(1);}
}
console.log('ok  '+n+' inline scripts');"
echo "== Unit tests"
(cd functions-syllabus && npm test)
(cd functions-test && npm test)
(cd functions-community && npm test)
(cd functions-discover && npm test)
echo "(functions-quiz has no automated tests in this project.)"
echo "ALL CHECKS PASSED"
