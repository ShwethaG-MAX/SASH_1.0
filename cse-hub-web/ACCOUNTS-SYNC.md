# CSE Hub — Student accounts, cross-device sync, Schedule restructure

## What changed (all in `public/index.html` unless noted)
**Login screen** – three student options: Continue with Email, Continue with Google, Continue as Guest (the original anonymous flow, unchanged). CR / Admin login are under "Staff".
**Email** – register / log in / show-hide password / password reset / validation / verification email (sent, never blocking).
**Google** – popup sign-in with account chooser; redirect fallback when popups are blocked. Blocked inside embedded WebViews by Google itself (the Android APK): the app tells the user to use Email or a browser.
**Guest → account** – a guest who registers by email or links Google keeps the *same* Firebase account (same UID), so progress is kept and uploaded. If the credential already belongs to another account the user is asked, signs in to it, and is then offered an explicit "import guest progress" merge. Nothing is merged on matching e-mail alone: a Google sign-in whose e-mail belongs to a password account must first log in with the password, then Google is linked.
**Onboarding** – shown only when `userProfiles/{uid}` lacks name / year / branch / section / batch (name-only for second-year AIML & ISE). Returning users go straight into the app. Profiles are keyed by UID only.
**Logout** – top-right button (icon + label ≥1180 px, icon-only on phones; between 821–1099 px the header is full so Log out is in the ☰ menu and Settings → Account). Guests get a warning (create account / download backup / erase / cancel). Accounts flush pending sync first. Logout signs out, wipes personal local data, clears the Firestore offline cache and reloads to the login screen.
**Sync** – `userData/{uid}/items/{key}`, one doc per key: attendance (+ settings, both year scopes), tasks, daily notes, favorites, recent, notification config, theme/appearance, study-cycle, tour-completed. Pull at login, live listener for data keys, debounced transactional push, merge on simultaneous edits, offline-tolerant retry. Quizzes / XP / syllabus tests / Discover were already per-UID in Firestore. Guests are never synced.
**Schedule** – tabs: Timetable · Event Calendar (Academic Events first) · Tasks (now also holds **My Calendar**) · Attendance (the whole attendance interface, moved). Attendance nav button removed; `#attendance` and `setMode('attendance')` land on Schedule → Attendance.
**Other** – backup file now also includes tasks and daily notes (older backups still restore).

## Firebase Console (once)
1. Authentication → Sign-in method → enable **Email/Password** and **Google**.
2. Authentication → Settings → Authorized domains: `cse-c-hub.web.app`, `cse-c-hub.firebaseapp.com` (and any custom domain).
3. Optional: Authentication → Settings → enable e-mail enumeration protection.

## Deploy (rules FIRST, then hosting)
```
firebase deploy --only firestore:rules
firebase deploy --only hosting
```
New rule block in `firestore.rules` (`match /userData/{uid}/items/{itemId}`): own UID only, non-anonymous only, key whitelist, field/size validation. Admin/CR rules are untouched. No migration is needed; existing guests keep working, and local data is reconciled the first time an account signs in.

## Known limits
- Anyone can register an e-mail ending `@cr.cse-hub.app` by calling Firebase directly (it grants nothing, but could squat a future CR username). Blocking it server-side needs Identity Platform blocking functions.
- Signing out cannot revoke refresh tokens server-side without the Admin SDK.
- Guest data erased on guest logout cannot be recovered (the warning offers account creation or a backup first).
- Simultaneous edits to the same item on two devices are merged by union; a deletion made concurrently with another device's edit can reappear.

## Testing
See `scripts/account-tests/` (Playwright + an in-memory Firebase stub). The stub is NOT Firebase; real Google sign-in, e-mail delivery, real rules and the Android app need manual testing.
