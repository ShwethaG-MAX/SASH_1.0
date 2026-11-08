Year-filtering regression tests for the Daily Quiz (not deployed; firebase.json does not reference this folder).
They run the REAL functions-quiz code against an in-memory Firestore, plus the real quiz module of public/index.html in jsdom.
  cd tests-quiz-year && npm install && npm test
scenarios.js = backend (28 checks); ui.js = browser module + backend together (13 checks).
