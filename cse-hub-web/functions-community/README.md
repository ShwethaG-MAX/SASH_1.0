# functions-community — chat reports & moderation (Student Centro)

Codebase name `community`, region `asia-south1`. Three isolated chat rooms: `linklearn` (Global Chat, everyone), `year1` (First Year Community) and `year2` (Second Year Community); a year room is open only to students of that year (enforced in firestore.rules `chatRoomOk`) (data lives under `chatRooms/{room}/…`).

## Callables
- **`chatReport({room, messageId, reason, details?})`** (any signed-in user). Reads the message itself (never trusts client text), snapshots it plus up to 5 earlier messages from the SAME room, resolves names from `userProfiles` (admin-only data) and writes `chatReports/{room}_{messageId}_{reporterUid}`.
  Refused: unknown room, message missing / in the other room (`not-found`), own message, repeat report of the same message (`already-exists`), more than 10 reports per rolling hour (`resource-exhausted`). Reasons: harassment, abusive, spam, inappropriate, impersonation, other. Details ≤ 500 chars.
- **`chatModerate({reportId, action, ...})`** (admin = custom claim `owner:true`). Actions: `setStatus` (`status`), `warn` (`text` ≤ 300 → `chatWarnings`), `deleteMessage` (message + its reactions/views in that report's room only), `restrict` (`hours` 0–8760, 0 = until lifted; `scope` `room`|`both`), `unrestrict` (`scope`), `dismiss`. Each appends a `chatModerationLog` row. Restricting merges with a still-active restriction on the other room; the new `until` applies to all rooms in the doc.

## Install, test, deploy
```
cd functions-community && npm install && npm test
# merge the files in _merge/ first (see below), then from the project root:
firebase deploy --only firestore:rules,firestore:indexes
firebase deploy --only functions:community
```
`_merge/` (not deployed): `rules.chat.txt` (replace the old communityChat/chatReactions/chatViews blocks + add helpers), `indexes.json` (append to `firestore.indexes.json` → `indexes`), `firebase.json.snippet` (add to `functions` array).

## Known limits
- Tests are offline unit tests with an in-memory Firestore. The Firestore **rules were not run in the emulator** — test them with `firebase emulators:start` before deploying.
- A restriction blocks creating messages/reactions via rules; it does not hide existing messages.
- Old `communityChat` data is kept read/delete-only and expires after 7 days as before.
