# Backend changes needed for team contact details + WhatsApp link

The frontend (`index.html`) only sends and reads these fields. The `teams` Cloud Functions
and Firestore rules are not in the HTML, so they must be updated for the data to persist.
Without them the form still works, but email, phone and the WhatsApp link are simply not saved.

## Where the data lives (so it stays members-only)

| Data | Location | Who can read |
|---|---|---|
| Applicant email / phone (pending request) | `teamRequests/{id}`: `contactEmail`, `contactPhone` | the leader (`to`) and the applicant (`from`), as today |
| Member email / phone (after accept) | `teams/{teamId}/members/{uid}`: `email`, `phone` | team members only, as today |
| WhatsApp group link | `teams/{teamId}/private/info`: `whatsappLink` | team members only (new) |

Do NOT put the WhatsApp link on the `teams/{teamId}` document: that collection is readable by everyone.

## Callable changes (region asia-south1)

1. `teamRequestSend` accepts optional `contactEmail` and `contactPhone`.
   Validate on the server: email matches a basic email pattern (max 100 chars), phone matches
   `^\+?\d{7,15}$`. Store them on the request document, or store empty strings.
2. `teamRequestDecide` on accept: copy `contactEmail` to `email` and `contactPhone` to `phone`
   when it creates `teams/{teamId}/members/{uid}`.
3. `teamCreate` and `teamUpdate` accept optional `whatsappLink`.
   Validate with `^https://chat\.whatsapp\.com/[A-Za-z0-9_-]{8,}(\?\S*)?$`.
   Write it to `teams/{teamId}/private/info` with `set({whatsappLink}, {merge: true})`.
   An empty string deletes the link. Only the team leader may change it.
4. `teamDelete`: also delete `teams/{teamId}/private/info`.
5. Optional: when a member leaves or is removed, nothing extra is needed, because their member
   document (with email and phone) is already deleted.

## Firestore rules (add inside `match /teams/{teamId}`)

```
match /private/{doc} {
  allow read: if request.auth != null
              && exists(/databases/$(database)/documents/teams/$(teamId)/members/$(request.auth.uid));
  allow write: if false;   // written only by the callables above
}
```

The `members` subcollection rule you already have (members of that team only) keeps email and
phone private. Check that it does not allow reads by every signed-in user.
