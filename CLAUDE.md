# House of Martin — Project Context

Read this file at the start of every session before touching any code.

## What This Is

A private, invite-only web app for one extended family (the Martins) — messaging,
event planning/RSVPs, a shared contacts directory, and photo/experience sharing.
No outside users except approved family friends with restricted access. No public
discovery, no ads, no algorithmic feed.

Full product spec (features, family model, roles/privacy, data model, roadmap) was
designed collaboratively and lives in this session's chat history — re-derive it from
this file + code if a future session needs the full writeup restated.

## Architecture

Single-page web app, no build step — plain HTML/CSS/JS with the Firebase v10 modular
SDK loaded via `<script type="module">` from the `gstatic.com` CDN (same pattern as
the `auggies-deploy` repo). Mobile-first, installable as a PWA.

| File | Purpose |
|---|---|
| `app/index.html` | The entire app shell — auth, nav, all tabs (Messages/Events/Contacts/Photos/Admin) |
| `firebase.json` | Hosting + Firestore + Storage config, plus emulator ports |
| `firestore.rules` | Firestore security rules |
| `storage.rules` | Cloud Storage security rules (photo uploads) — see gotcha below |
| `.firebaserc` | Project alias, points at the real `house-of-martin` project |

## Firebase Project

**Live.** Project ID `house-of-martin`, Firestore (nam5) + Auth (Email/Password) +
Storage all created and enabled. Deploy with:
```bash
firebase deploy --only firestore:rules,storage,hosting --project house-of-martin
```
Bootstrapping a brand-new environment from scratch (new project) needs two one-time
manual console steps the CLI can't do: enabling Email/Password sign-in under
Authentication → Providers, and clicking "Get Started" on the Storage tab (may
prompt to upgrade to the Blaze plan — required for Storage, free tier is generous
enough for a family app). Firestore itself auto-enables via `firebase deploy`.

First admin bootstrap is also manual (chicken-and-egg: signup needs an invite code,
invite codes need an admin to create them): manually add one `inviteCodes/{code}`
doc with `role: "admin"` via the Firestore console, sign up with it, then manually
flip that user's `status` from `pending` to `approved` in the console. Every
account after that goes through the normal in-app invite-code + admin-approval flow.

## Known gotcha: don't use cross-service Storage↔Firestore rules

`storage.rules` does **not** use `firestore.get()`/`firestore.exists()` to check a
user's role/approval status, even though that's the "correct-looking" way to gate
Storage access on Firestore-held state. It was tried for photo uploads and failed
with `storage/unauthorized` for a legitimately approved admin account, for reasons
that didn't reproduce with a plain `request.auth != null` rule (isolated by
temporarily deploying that permissive rule and confirming it worked immediately).
Rather than sink more time into an unreliable cross-product feature, Storage rules
are intentionally just "signed in," relying on `firestore.rules` (which works
reliably) to gate *metadata* visibility — an unapproved/uninvited account can never
learn the random album/photo path needed to reach a Storage object directly. If a
future session is tempted to "properly" restrict Storage by role again, know that
this was already tried and abandoned for a working reason, not skipped out of
laziness.

## Data Model

- **User** (`users/{uid}`): name, email, phone, birthdate (age shown publicly only if ≤21),
  role (member/friend/admin), status (pending/approved), householdId, inviteCodeUsed
- **Household** (`households/{id}`): name, memberIds[], responderId (RSVPs/edits for the household),
  phone, address, anniversary, extraContacts[] ({id, name, birthdate, phone} — family members with
  no account of their own, e.g. young kids or relatives who'll never sign up)
- **Branch** (`branches/{id}`): name, householdIds[]
- **InviteCode** (`inviteCodes/{code}`): role (what new signups using this code become)
- **Channel** (`channels/{id}`): name, type (family/household/branch), householdId or branchId, invitedUserIds[] (friends)
  - `messages` subcollection: text, senderId, senderName, createdAt
- **Event** (`events/{id}`): title, when, where, hostId, hostName, audience ('everyone'|'custom'),
  invitedHouseholdIds[], invitedBranchIds[], invitedUserIds[] (flat resolved uid list — also what
  `isFriendInvitedTo()` in firestore.rules checks, so a friend picked as an individual invitee
  actually gets read access). Read access is **not** restricted by audience — every approved member
  can browse and RSVP to every event regardless of who was formally invited; `audience` is invite
  *addressing* (who the host meant to reach, shown as "Invited: ..." on the card), not a visibility
  boundary. That was a deliberate simplification: Firestore's list-query rules can't safely
  per-document-filter a broad `collection(db,'events')` query by a field like this without reworking
  every event query to be provably scoped, which was out of proportion to the ask.
  - `rsvps` subcollection, keyed by member uid: status, submittedBy, name, householdId, viaHousehold
- **Album** (`albums/{id}`): title, createdBy, visibility, invitedUserIds[] (friends)
  - `photos` subcollection: url, storagePath, uploaderId, uploaderName, createdAt

## Roles & Privacy

- **Admin**: approve members/friends, manage households/branches, generate invite codes, full visibility
- **Member**: full access to family/household/branch channels, directory, events, photos; can RSVP for self or household (if responder)
- **Family friend**: access limited to specific invited channels/events/albums only — no full directory, no unrelated content

## MVP Scope (Phase 1) — status

**Built:** invite-code-gated signup + admin approval, households/branches with
"respond as a family" RSVP, family/household/branch messaging channels, event
RSVP with live counts, contacts directory grouped by household, real photo
upload to Storage, age badges (≤21) with self/admin-editable birthdate.

**Deferred:** DM channels, household self-service editing of shared contact info
(currently admin-only), notification digests, family tree view, item sign-up
lists, native app wrapper.

## Working Style / Preferences

(Carried over from the developer's other project — apply here too.)

- Prefer diagnosing root cause over patching symptoms
- Surgical, precise edits — verify exact anchor text before replacing
- Syntax-check JS after edits (`node --check` on extracted script blocks, or equivalent)
- No build step, no framework — plain HTML/JS matching the `auggies-deploy` repo's style
