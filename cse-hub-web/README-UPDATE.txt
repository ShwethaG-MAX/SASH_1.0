SYLLABUS PRACTICE UPDATE — copy these into your project folder ("cse-hub-web"), keeping the same relative paths.

REPLACE (existing files):
  public/index.html        <- new full file (your old one + Syllabus Practice)
  firestore.rules          <- your old rules + one new block (nothing removed/changed)
  firebase.json            <- adds ONE line: the "syllabus" functions codebase

ADD (new folder):
  functions-syllabus/      <- index.js, score.js, test.js, package.json

DO NOT TOUCH: functions-quiz/, firestore.indexes.json, .firebase/, node_modules/

Then, in the project folder:
  cd functions-syllabus && npm install && npm test && cd ..
  firebase deploy --only firestore:rules
  firebase deploy --only functions:syllabus
  firebase deploy --only hosting
