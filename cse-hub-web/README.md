# STUDENT HUB (CSE HUB) — unified project

Single-page Firebase app (`public/index.html`) with three Cloud Functions codebases, all in region `asia-south1`.

| Part | Folder | Codebase | What it does |
|---|---|---|---|
| Web app | `public/` | hosting | One self-contained `index.html`: schedule, attendance, study, community, Daily Quiz, Syllabus Test, **Discover**, Total XP, admin/CR dashboards, themes |
| Daily Quiz | `functions-quiz/` | `quiz` | Year-specific daily quiz, scoring, leaderboards, AI question generation, admin tools |
| Syllabus Test + XP | `functions-syllabus/` | `syllabus` | Server-side scoring, deduplicated XP awarding (`sylSubmit`), XP summary (`xpGetSummary`) |
| Discover | `functions-discover/` | `discover` | News ingestion (DEV.to, Hacker News, NewsData.io), daily refresh, anonymous comments, reports/moderation |
| Config | `firebase.json`, `firestore.rules`, `firestore.indexes.json` | | Merged from both versions (see "Rules and indexes") |
| Scripts | `scripts/` | | `check-all.sh` (offline validation), `backfill-syllabus-xp.js` (optional one-off) |

## Prerequisites
- Node.js 22, Firebase CLI (`npm i -g firebase-tools`), a Firebase project on the **Blaze** plan.
- Authentication → **Anonymous** sign-in enabled. Firestore created. Put your web config in `FIREBASE_CONFIG` inside `public/index.html` (already set if you are updating an existing project).
- Admin/owner access uses the `owner` custom claim exactly as before; nothing changed there.

## Secrets (Firebase Secret Manager)
| Secret | Used by | Notes |
|---|---|---|
| `QUIZ_AI_API_KEY` | `quiz` | Already required by the Daily Quiz AI generator |
| `NEWSDATA_API_KEY` | `discover` | Free key from https://newsdata.io. Set it to the word `none` to run Discover on DEV.to + Hacker News only |

```bash
firebase functions:secrets:set QUIZ_AI_API_KEY      # skip if already set
firebase functions:secrets:set NEWSDATA_API_KEY     # paste the key, or: none
```
DEV.to and Hacker News need no account. Read NewsData.io's current terms before launch. Discover stores only title, short description, publisher, date, link and image URL, and hot-links images.

## Install and validate (nothing is deployed)
```bash
(cd functions-quiz && npm ci)
(cd functions-syllabus && npm ci)
(cd functions-discover && npm ci)
bash scripts/check-all.sh        # JSON, JS syntax (functions + inline page scripts), syllabus/XP tests, discover tests
```

## Deploy (only when you are ready — this project was NOT deployed by the merge)
Order matters: rules and indexes first, then functions, then hosting.
```bash
firebase deploy --only firestore:rules,firestore:indexes
firebase deploy --only functions:quiz,functions:syllabus,functions:discover
firebase deploy --only hosting
```
- Index builds take a few minutes. Until they finish, Discover shows "database index is still being built"; retry.
- First time: open Discover → **Fetch articles now**, or wait for the 05:30 IST job (or run `discoverDailyRefresh` once from Cloud Scheduler).
- Cloud Scheduler: Discover adds 2 jobs (`discoverDailyRefresh`, `discoverEnsureFresh`) on top of the quiz jobs; the free tier covers 3 jobs per billing account, so a few cents per month may be billed.
- No data migration is needed; existing users, quizzes, attempts and XP are untouched.

## Rules and indexes (how they were merged)
- `firestore.rules` = Discover version's rules (strict leaderboard rule `qzGroup()` plus all Discover collections) **plus** the XP version's `userXp` and `syllabusXpLedger` rules. Nothing from either file was loosened; all client writes to XP, Discover articles/comments/authors/reports are denied.
- Student leaderboards (`quizBoards`, `dailyQuizResults`, `weeklyQuizResults`) are readable only for the student's own academic year; the owner can read both. The Quiz page therefore shows each student only their own year's board (no year toggle). The owner/admin board keeps the toggle.
- `firestore.indexes.json` = union (the 5 quiz indexes + 2 Discover indexes; TTL overrides on `quizRate` and `discoverRate`).
- `firebase.json` = hosting + Firestore + the three function codebases (`quiz`, `syllabus`, `discover`).
- The `FIRESTORE_RULES` constant embedded inside `index.html` (a first-run console helper) was already out of date in both source versions and is unchanged. `firestore.rules` is the source of truth.

## XP rules (functions-syllabus/xp.js)
Per unit test: `10 + round(percentage * 40 / 100)` (0 if nothing answered). A unit pays at most its best-ever XP; a better retake adds only the improvement. Override via Firestore `syllabusConfig/settings.xp = {completion, scoreBonusMax}`. Total XP = Syllabus Test XP (`userXp/{uid}`) + Daily Quiz XP (sum of `quizXpLedger`). Leaderboards read Daily Quiz data only. The browser never calculates or writes XP.

Optional one-off for tests completed before XP existed (idempotent):
```bash
cd functions-syllabus
GOOGLE_APPLICATION_CREDENTIALS=key.json node ../scripts/backfill-syllabus-xp.js --dry   # preview, then run without --dry
```

## Discover notes
- Browsers never call news APIs. The backend fetches, normalises and de-duplicates (document id = hash of the cleaned URL) into `discoverArticles`; everyone reads the same records and the app filters by the student's interests.
- Automatic refresh: `discoverDailyRefresh` at 05:30 IST and `discoverEnsureFresh` every 6 h (re-runs only if the last success is older than 26 h). Manual Refresh uses one global lock and a 20-minute cool-down (5 minutes after a failed run).
- Comments are anonymous in the public document (text, time, parent). The author link is in server-only collections. Posting goes through a Cloud Function: 800 characters, link/repeat spam checks, 5/min and 40/h per student, duplicate-text block. Authors can delete their own comments; 3 different reporters auto-hide a comment; the admin sees a **Reports** button to remove or restore.
- Students use Firebase anonymous sign-in (one account per browser/device). Interests and bookmarks persist on that account; clearing site data or changing device starts a new one.
- Adding a Discover domain: add the same id in `functions-discover/lib/domains.js`, `DV_DOMAINS` in `public/index.html`, and `dvInterests()` in `firestore.rules`. `npm test` in `functions-discover` fails if they disagree.

## Troubleshooting
- "Discover service is not reachable": deploy `functions:discover` first.
- Leaderboard shows an academic-year message: re-select year in Settings → Academic profile so `userProfiles/{uid}.year` is saved.
- NewsData quota/limits simply stop that source; DEV.to and Hacker News keep working.

## First-year P / C cycle selector (Study Materials)
First-year students (except CSBS, which has its own subject set) get a **P Cycle / C Cycle** switch above the existing subject cards. The cards are the timetable subjects of the chosen cycle (`fyStudySubjects`), and each card's links come from `FY_LINKS` in `public/index.html` (search "First-year study links"). Add a link by pushing `{cycle, subject:<subject code>, category, unit, title, desc, url, status, source}`; invalid/non-https URLs are never shown. `FY_LINKS_UNASSIGNED` lists reference-site links with no matching timetable subject. The choice is remembered in `localStorage` (`fyStudyCycle`). No Firebase/Firestore changes.
PYQs: links with `category:'PYQs'` in `FY_LINKS` appear as a "PYQs" folder inside the subject card; the C-cycle-only "PYQs" card (subject code `PYQ`) holds CIE 1 / CIE 2 / SEE 2025.
