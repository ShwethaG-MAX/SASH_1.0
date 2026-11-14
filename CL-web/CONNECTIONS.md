# Student connections (Connect > Teams > Connections)

Send / receive / accept / reject / cancel / remove requests between real, signed-in students. Uses the existing Firebase app, Auth and Firestore (no second app).

## What changed
- `functions-connections/` (new codebase `connections`, region asia-south1): callables `connSend`, `connRespond`, `connCancel`, `connRemove`, `connMutuals`, `connSuggest`. All writes are server-side and transactional; guests are refused.
- `firestore.rules`: `connectionRequests`, `connections`, `connNotifs/{uid}/items`, `userConns`. Clients can only READ their own docs (and mark their own notifications read / delete them). No client can create, accept or edit a request.
- `firebase.json`: registers the `connections` functions codebase.
- `firestore.indexes.json`: no change needed. Every query is equality-only (`to==uid`, `from==uid`, `users array-contains uid`) or a single-field `orderBy`.
- `public/index.html` and `CL-app/app/src/main/assets/index.html` (same edits in both): Connections tab (Received / Sent / My Connections), live badges (Connect button + tab), live toasts and Recent activity, People you may know, mutual counts, and the Connect button in Find people and the peer profile now sends real requests.

## Deploy (in this order)
    cd CL-web
    cd functions-connections && npm install && npm test && cd ..
    firebase deploy --only firestore:rules
    firebase deploy --only functions:connections
    firebase deploy --only hosting
For the Android app, rebuild `CL-app` (its bundled `index.html` carries the same change).
Functions need the Blaze plan (the other codebases already do).

## Tests
- `cd functions-connections && npm test`: 11 two/three-account logic tests on an in-memory Firestore.
- `tests-connections/e2e.js [path-to-index.html]`: two real browser sessions (Asha, Bhuvan, plus Chitra for mutuals) against a Firebase stub driven by the real `lib/core.js`. Needs `playwright`. Not run against real Firebase.
