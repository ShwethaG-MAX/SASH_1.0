# functions-test — the "Test" backend (replaces Syllabus Test)

Contract: `../API-CONTRACT.md` section A. Region `asia-south1`. Codebase name `test` (see `firebase.json`).

## Setup
1. `cd functions-test && npm install` (adds `pdf-parse` and `mammoth`; commit the generated `package-lock.json`).
2. `npm test` — offline unit tests. The real PDF/DOCX round-trip tests only run once step 1 has installed the two libraries.
3. AI extraction (optional): reuses the Daily Quiz setup. Secret `QUIZ_AI_API_KEY` must exist (`firebase functions:secrets:set QUIZ_AI_API_KEY` if you have not already) and
   `quizSettings/config` supplies `generationProvider` / `generationModel` (anthropic | openai | groq | gemini). No key ⇒ the rule-based extractor is used automatically.
4. Deploy: `firebase deploy --only firestore:rules,firestore:indexes` then `firebase deploy --only functions:test` (and `functions:syllabus` once, to drop the removed `sylSubmit`).
   Indexes take a few minutes to build; the leaderboards show an index error until they finish.

## Behaviour
- Admin uploads PDF or DOCX (≤ 6 MB). Legacy `.doc` is rejected with an explanation. Scanned/image-only PDFs have no text layer and are rejected (no OCR).
- **AI** (when configured): extracts questions/options/answers and categorises subject/unit/topic. Output is strictly validated; invalid items are dropped; any failure falls back to the parser.
- **Rule-based**: numbered questions (`1.` `1)` `Q1.`), options `A)`/`A.`/`(A)` (own lines or inline), `Answer: B`, trailing "Answer Key" table, `[2 marks]`, and headings `Unit/Module/Chapter/Section N`, `Subject:` for categories; otherwise "Uncategorised". Questions with missing options/answer are flagged `needsReview`.
- The admin must review/correct before publishing; `testSetStatus` refuses to publish incomplete questions.
- One attempt per student per test (`testAttempts/{testId}_{uid}`), server-timed (deadline + 2 min grace). Time-expired attempts can be reset with `testResetAttempt`.
- If `maxMarks` is set, question marks are scaled so a perfect score equals it. `percentage` is always based on raw marks.
- Leaderboards use only `testResults` / `testStats` (overall points = sum of each test's percentage). Tests award no XP; Daily Quiz data is never read or written.

## Migration (backward compatible)
- Nothing is deleted. Legacy `syllabus*`, `units`, `subjects`, `userSyllabusProgress`, `syllabusXpLedger`, `userXp` documents stay; their rules are now read-only, so historic Syllabus Test XP still shows in the XP popup via `xpGetSummary`.
- `branches`, `academicYears`, `subjects`, `units` rules are unchanged (they are not used by the app outside the removed Syllabus UI, but removing them is not needed).
- `scripts/backfill-syllabus-xp.js` is unchanged and still works against the legacy data.
- Storage: question papers are written by the function (Admin SDK) to `testPapers/{testId}/…`; no client Storage access is needed, keep any Storage rules closed for that path.
