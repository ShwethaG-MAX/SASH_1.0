# Student Centro — project-wide update (deploy, test, status)

Same app, same architecture (single-file `public/index.html` + Firebase). Nothing was renamed in Firebase; "Student Hub" → "Student Centro" is user-facing text only.

## What changed (item → where)
| # | Item | Where |
|---|---|---|
| 1 | Homepage XP card removed; top-right XP chip opens a popup (total, Daily Quiz XP, Syllabus Test XP; closes on outside click / Esc). XP still comes from `xpGetSummary` (server) | `index.html` (`xpHubJs`, `#xpPop`), `functions-syllabus` |
| 2 | First-year calendar replaced by the supplied AY 2026-27 calendar (all branches, ranges, notes, tentative disclaimer, PDF link); second-year calendar untouched | `index.html` (`CAL_FY_*`), `public/docs/academic-calendar-1st-sem-2026-27.pdf` |
| 3 | Top-right Save (floppy) button removed; Backup & Restore kept in Settings | `index.html` |
| 4 | Syllabus Test → **Test** (admin upload PDF/DOCX, AI/heuristic extraction + review, publish/unpublish/edit/remove, timed attempt, server scoring, one attempt, per-test + overall leaderboard, no answer keys before submit, no XP) | `functions-test/`, `index.html` (`testJs`, `testAdminJs`), rules, indexes |
| 5 | Branding → Student Centro | `index.html` |
| 6 | Two independent chats **LinkLearn** and **StudyChat** (separate Firestore paths `chatRooms/{room}/…` and rules). They replace the old single Chat; the old Q&A/resources feature is retitled "Exam Q&A & Resources". Old `communityChat` data is kept (read/delete only) | `index.html`, `firestore.rules` |
| 7 | Login: only Student / CR / Admin first; Student reveals Guest / Google / Email; "Staff" label removed; auth logic untouched | `index.html` |
| 8 | Report message (6 categories + details) in both chats; admin **Reports** tab (status, warn, delete message, restrict, audit trail, dedupe, rate limit) | `functions-community/`, `index.html` (`chatModJs`), rules |
| 9 | Replies with quoted preview, tap-to-jump, validated per room by rules | `index.html`, rules |
| 10 | Three synthesized sounds (sent / received / notification), mute switch in Settings and chat header, autoplay-safe | `index.html` (`soundJs`) |
| 11 | Sheynix eyes ~12% smaller (`ER .33→.29`, iris `.285→.25`) | `index.html` |
| 12 | Tour rewritten for the new features | `index.html` (`TOUR_STEPS`) |
| 13 | Rules, indexes (17), `firebase.json` (codebases quiz, syllabus, test, community, discover), embedded rules text synced | repo root |

## Install & test
```
cd functions-test && npm install && npm test      # runs the real PDF/DOCX round-trip too
cd ../functions-community && npm install && npm test
cd ../functions-syllabus && npm install && npm test
cd ../functions-discover && npm install && npm test
cd ../tests-quiz-year && npm install && npm test  # existing Daily Quiz regression suite
cd .. && bash scripts/check-all.sh                # offline: JSON, syntax of every function and every inline script, unit tests
```

## Deploy (in this order)
1. `firebase deploy --only firestore:indexes` — wait until all indexes show *Enabled* (can take minutes; leaderboards/reports queries fail until then).
2. `firebase deploy --only firestore:rules`
3. Secret for AI extraction (optional; without it a heuristic extractor is used): `firebase functions:secrets:set QUIZ_AI_API_KEY`; provider/model in Firestore doc `quizSettings/config` (`generationProvider`, `generationModel`) as for the Daily Quiz.
4. `firebase deploy --only functions` (codebases quiz, syllabus, test, community, discover; region asia-south1)
5. `firebase deploy --only hosting`
Storage rules: **no change needed** — chat media still uses `chatMedia/{uid}/{file}` (the file name is now prefixed with the room).

## Migration / backward compatibility
- No collection is deleted or renamed. Old `communityChat`, `chatReactions`, `chatViews` stay readable/deletable (so old messages still expire); new messages go to `chatRooms/{room}/…`. Old messages are **not** copied into LinkLearn.
- Old `syllabusTests`/attempt data is left in place; its client writes are frozen in rules.
- Admin = custom claim `owner===true` (unchanged). CR accounts, guest flow unchanged.

## Honest status — what was and was NOT verified
Verified here: all offline unit tests pass (community 13, test backend, syllabus, discover 33, JSON/syntax of all inline scripts); the page loads in headless Chromium with no JavaScript errors; login shows only Student/CR/Admin and Student reveals the three methods.

NOT verified (no Firebase project, emulator or network was available in this environment) — please test after deploying:
- **Firestore rules** were written and reviewed (brace-balanced) but never run against the emulator.
- **Cloud Functions against real Firebase** (callables, transactions, index-dependent queries such as ranks and report rate limiting).
- **PDF/DOCX parsing and AI extraction**: the real round-trip tests were SKIPPED (npm registry blocked here: `pdf-parse`, `mammoth` not installed). Run `npm test` in `functions-test`. Always review extracted questions/answer keys in the admin Test screen before publishing.
- **Two-device chat behaviour**: room isolation, replies, sounds, unread badges, restriction banner, warnings — logic exists and is syntax-checked, but was not exercised with live data. Sounds cannot be heard in headless tests.
- Visual polish (mobile layouts of the new Test, Reports and chat-room UI) was not screenshot-reviewed on real devices.
- `tests-quiz-year` (jsdom) was not re-run (needs `npm install`).
- Sheynix eye size is a numeric change; check it visually and tune `ER` in `livingAvatarJs`/`dragonAvatarJs` area (`EX/EY/EZ/ER`) if you want it larger/smaller.
- The calendar's ambiguous "&" dates in the PDF are shown as separate dates; check against the PDF.
- Tests now award XP (10 + up to 40). The XP popup shows it with legacy syllabus XP as "Tests". Mode "Quiz" is now "Contests" with tabs: Daily Quiz, Quiz Leaderboard (Daily/Weekly), Tests, Test Leaderboard, Overall Leaderboard, My Quiz Statistics. Run `scripts/backfill-xp-totals.js` once after deploying (see its header).
