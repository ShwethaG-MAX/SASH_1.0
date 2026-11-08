# Student Centro — backend contract (Test + Community)

Region for ALL new callables: `asia-south1` (same as quiz/syllabus/discover). Callables are v2 `onCall({cors:true})`.
Admin = ID-token custom claim `owner === true` (same as firestore.rules `isOwner()`). Students = any other signed-in user (anonymous/Google/email).
Display identity of a student is read server-side from `userProfiles/{uid}` → `{name (trim, ≤40), year, branch}` (same source the Daily Quiz uses).
Never send correct answers to a student before they submit.

## A. TEST (new codebase `functions-test`, codebase name `test`)

### Collections
| Collection | Doc id | Fields | Client access |
|---|---|---|---|
| `tests` | auto | `title`, `description`, `totalQuestions` (admin-declared int), `durationMin` (int 1–600), `maxMarks` (number or null), `status` `'draft'\|'published'\|'unpublished'`, `sourceFile {name,size,mime,storagePath}`, `extraction {status:'ready'\|'failed', method:'ai'\|'heuristic', warnings:[string], questionCount}`, `questionCount` (included, valid questions — kept in sync by functions), `createdBy`, `createdAt`, `updatedAt`, `publishedAt` | read: owner any; signed-in users only `status=='published'`. create/delete: functions only. update: owner may edit `title, description, totalQuestions, durationMin, maxMarks, updatedAt` but NOT `status`/`questionCount`/other fields |
| `testQuestions` | auto | `testId`, `order` (int), `text`, `options` ([string] 2–6, may be [] for flagged questions), `marks` (number, default 1), `subject`, `unit`, `topic`, `included` (bool), `needsReview` (bool), `confidence` (0–1) | read: owner any; signed-in users: NEVER directly (students get questions through `testStart`). write: owner |
| `testKeys` | same id as the question | `testId`, `correctAnswer` ('A'..'F' or ''), `explanation` | owner only (read+write) |
| `testAttempts` | `{testId}_{uid}` | `uid`, `testId`, `testTitle`, `status` `'started'\|'submitted'\|'expired'`, `startedAt`, `deadlineMs`, `submittedAt`, `answers`, `score`, `maxScore`, `percentage`, `correct`, `incorrect`, `unanswered`, `total`, `durationMs`, `review[]` (only written on submit: `{questionId,text,options,marks,subject,topic,yourAnswer,correctAnswer,explanation,isCorrect}`) | read: owner, or `resource.data.uid==auth.uid`. write: functions only |
| `testResults` | `{testId}_{uid}` | `testId`, `testTitle`, `uid`, `name`, `branch`, `year`, `score`, `maxScore`, `percentage`, `correct`, `total`, `durationMs`, `submittedAt` | read: any signed-in user. write: functions only. Created exactly once per (test,student) — ONE attempt per test |
| `testStats` | `{uid}` | `uid`, `name`, `branch`, `year`, `testsTaken`, `totalPoints` (= sum of each test's percentage), `avgPercentage`, `totalScore`, `totalMax`, `totalTimeMs`, `updatedAt` | read: any signed-in user. write: functions only |

Test leaderboard is built ONLY from `testResults` / `testStats`. It never reads Daily Quiz collections and never writes `userXp` / `quizXpLedger`.

**Test XP:** each submitted test earns `10` (if at least one question answered) `+ round(percentage/100*40)` XP, stored as `xp` on `testResults` / `testAttempts` and summed into `testStats.totalXp`. `testSubmit` also mirrors it into `xpTotals/{uid}` = `{quizXP, testXP, legacyXP, totalXP}` (quizXP is incremented by the quiz functions; legacyXP is old Syllabus XP set by `scripts/backfill-xp-totals.js`). Leaderboards: Test = `testStats` by `totalXp`; Overall = `xpTotals` by `totalXP` (clients read only, rules forbid writes). `xpGetSummary` now also returns `testXP`.

**Code in questions:** question/option/explanation text may contain ``` fenced blocks; whitespace inside a fence is preserved.
Per-test board query (client): `testResults.where('testId','==',id).orderBy('score','desc').orderBy('durationMs','asc').limit(100)`.
Overall board query (client): `testStats.orderBy('totalPoints','desc').orderBy('totalTimeMs','asc').limit(100)`.

### Callables (all require auth)
Admin only (HttpsError `permission-denied` otherwise):
- `testExtract({ fileName, mimeType, dataBase64, title, description?, totalQuestions, durationMin, maxMarks? })`
  Validates (title 1–120, durationMin 1–600, totalQuestions 1–300, file ≤ 6 MB decoded, magic bytes: PDF `%PDF` or DOCX zip `PK` with `word/document.xml`; `.doc` legacy rejected with a clear message). Extracts text (PDF text layer / DOCX via mammoth). Scanned PDFs with no text → `failed-precondition` with an understandable message. Extracts questions + options (+ answer key if the paper contains one, e.g. "Answer: B" / answer table) and categorises each by `subject`/`unit`/`topic` (AI when the provider key is configured — reuse the quiz provider setup: secret `QUIZ_AI_API_KEY`, config doc `quizSettings/config` `generationProvider`/`generationModel` — otherwise a deterministic heuristic: headings like "Unit 1", "Module 2", "Section A", "Subject:" carry down onto following questions; else subject/topic = 'Uncategorised'). Stores original file via Admin SDK at `testPapers/{testId}/{safeName}`. Creates `tests/{id}` (status `draft`) + `testQuestions` + `testKeys` (empty `correctAnswer` when unknown; question `needsReview:true` when key/options missing or low confidence). Returns `{ testId, questionCount, method, warnings:[string] }`.
- `testSetStatus({ testId, status:'published'|'unpublished' })` — publishing validates: ≥1 included question; every included question has 2–6 non-empty options and a key that is one of its letters; otherwise `failed-precondition` with a message naming the problem question numbers. Sets `publishedAt`, recounts `questionCount`.
- `testDelete({ testId })` — deletes test, its questions, keys, attempts, results, stored file, then recomputes `testStats` for affected students.
- `testResetAttempt({ testId, uid })` — deletes that student's attempt + result (e.g. time-expired / technical failure) and recomputes their `testStats`.
Student (any signed-in):
- `testStart({ testId })` → if not published → `not-found`. If the student already SUBMITTED: `{ state:'submitted', result:<attempt summary incl. review> }`. If `expired`: `{ state:'expired' }`. Else creates/resumes the attempt (server clock; `deadlineMs = startedAt + durationMin*60000`) and returns `{ state:'in_progress', test:{id,title,description,durationMin,questionCount,maxMarks}, deadlineMs, serverNowMs, questions:[{id,order,text,options,marks,subject,topic}] }` — NO keys. If deadline already passed → mark `expired`, return `{state:'expired'}`.
- `testSubmit({ testId, answers:{questionId:'A'..'F'|null} })` → idempotent (second call returns stored result). Allowed until `deadlineMs + 120000`; later → attempt marked `expired`, `HttpsError('deadline-exceeded','TIME_UP')`. Scores server-side against `testKeys`, writes attempt (+`review`), `testResults`, updates `testStats` in one transaction. Returns `{ state:'submitted', attemptId, testId, testTitle, score, maxScore, percentage, correct, incorrect, unanswered, total, durationMs, review:[…], rank:{ position, outOf } }`.
- `testMyResult({ testId })` → same shape as the submitted return (or `{state:'none'}`), used to reopen a finished test.

## B. COMMUNITY (new codebase `functions-community`, codebase name `community`)

Two completely independent rooms, id ∈ `linklearn`, `studychat`. Isolation is in the Firestore PATH (and rules), not in the UI.

### Collections
| Path | Fields | Client access |
|---|---|---|
| `chatRooms/{room}/messages/{id}` | `room` (== path room), `anonymousId` (== auth uid), `message` (1–1000), `createdAt`, `expiresAt`, optional `replyTo {id, anonymousId, snippet(≤140), hasMedia}`, plus the existing media fields (`mediaType, mediaName, mediaSize, mediaPath, mediaMime, viewOnce, …` — copy exactly the fields the current `communityChat` rule/code allows) | read: signed-in; create: `okClient()`, own uid, `room` matches path, not restricted (see below), `replyTo` (if present) must reference an existing message IN THE SAME ROOM path and `replyTo.id` must match; update/delete: author, owner deletes any; expired delete as today |
| `chatRooms/{room}/reactions/{msgId_uid}` | `msgId`, `uid`, `emoji`, `room`, `expiresAt` | same rules as old `chatReactions` but path-scoped; the referenced message must exist in the same room |
| `chatRooms/{room}/views/{msgId_uid}` | as old `chatViews`, path-scoped | same as old |
| `chatRestrictions/{uid}` | `rooms:[ 'linklearn'\|'studychat' ]` (both for a full restriction), `until` (timestamp or null = until lifted), `reason`, `by`, `createdAt` | read: that uid (so the UI can say "you're restricted") + owner; write: functions only. Rules: message create denied when a non-expired restriction covers that room |
| `chatReports/{reportId}` | reportId = `{room}_{messageId}_{reporterUid}` ⇒ one report per reporter per message. `room`, `messageId`, `reportedUid`, `reportedName`, `reportedBranch`, `reportedYear`, `reporterUid`, `reporterName`, `reason` ∈ `harassment, abusive, spam, inappropriate, impersonation, other`, `details` (≤500), `messageText` (server snapshot), `messageHasMedia`, `context:[{id,uid,text,createdAtMs}]` (up to 5 preceding messages in that room), `messageCreatedAtMs`, `createdAt`, `status` `'pending'\|'reviewed'\|'resolved'`, `reviewedBy`, `reviewedAt`, `lastAction`, `messageDeleted` | read: owner only; write: functions only |
| `chatModerationLog/{id}` | `reportId`, `room`, `action`, `targetUid`, `messageId`, `by`, `note`, `createdAt`, `detail` | read: owner only; write: functions only (append-only audit trail) |
| `chatWarnings/{id}` | `uid`, `room`, `text`, `createdAt`, `reportId` | read: `resource.data.uid==auth.uid` or owner; write: functions only. Client may update ONLY `seenAt` (own docs) |

Old `communityChat`, `chatReactions`, `chatViews` collections are kept READ + DELETE only (legacy data is not destroyed and old messages still expire); new creates/updates are denied.

### Callables
Student (signed-in):
- `chatReport({ room, messageId, reason, details? })` → server reads the message (never trusts client text), rejects: unknown room, message not found, reporting own message (`failed-precondition`), message already reported by this user (`already-exists`, friendly text), > 10 reports per user per rolling hour (`resource-exhausted`). Also resolves names from `userProfiles` (admin-only data). Returns `{ ok:true, reportId }`.
Admin only:
- `chatModerate({ reportId, action, note?, hours?, scope? })` with `action` ∈ `setStatus` (`status`: pending|reviewed|resolved), `warn` (`text` required ≤300 → `chatWarnings`), `deleteMessage` (Admin SDK delete of the message + its reactions/views in that same room; sets `messageDeleted`), `restrict` (`hours` 1–8760 or `0`=until lifted; `scope`: `'room'` (the report's room) or `'both'`), `unrestrict`, `dismiss` (sets status resolved, `lastAction:'dismissed'`). Every action appends `chatModerationLog` and updates the report (`status`, `lastAction`, `reviewedBy/At`). Returns `{ ok:true }`.
