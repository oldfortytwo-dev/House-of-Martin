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
| `app/index.html` | The entire app shell — auth, nav, all tabs (Messages/Events/Contacts/Photos) |
| `firebase.json` | Hosting + Firestore config |
| `firestore.rules` | Security rules |
| `.firebaserc` | Project alias — **placeholder, needs a real Firebase project ID** |

## Firebase Project

**Not yet created.** To stand up the backend:
1. `firebase projects:create house-of-martin` (or create via console.firebase.google.com)
2. Update `.firebaserc` with the real project ID
3. Enable Firestore + Authentication (Email Link or Phone) in the Firebase console
4. `firebase deploy --only firestore:rules,hosting`

## Data Model

- **User**: id, name, email/phone, role (member/friend/admin), household_id
- **Household**: id, name, member_ids[], responder_id (who can RSVP for the household), shared contact fields
- **Branch**: id, name, household_ids[], parent_branch_id (optional)
- **Channel**: id, name, type (family-wide/branch/household/DM/event-linked), member_ids[]
- **Message**: id, channel_id, sender_id, content, attachments[], timestamp
- **Event**: id, title, date/time, location, host_id, invited (branch_ids/household_ids/user_ids), item sign-up list
- **RSVP**: event_id, responder_id (user or household), status (yes/no/maybe), headcount, submitted_by
- **Album**: id, title, linked_event_id (optional), visibility scope (family/branch/event-invitees)
- **Photo**: id, album_id, uploader_id, url, caption, comments[]

## Roles & Privacy

- **Admin**: approve members/friends, manage branches/households, moderate, full visibility
- **Member**: full access to family channels, directory, events, photos; can RSVP for self or household (if responder)
- **Family friend**: access limited to specific invited channels/events only — no full directory, no unrelated content

## MVP Scope (Phase 1)

Invite-only signup/approval, households/branches, messaging (family + branch + DMs),
events + RSVP (individual and household-level), contacts directory, basic photo
upload tied to events.

**Deferred:** family tree view, potluck/item sign-up lists, notification digests,
native apps, photo tagging, polls.

## Working Style / Preferences

(Carried over from the developer's other project — apply here too.)

- Prefer diagnosing root cause over patching symptoms
- Surgical, precise edits — verify exact anchor text before replacing
- Syntax-check JS after edits (`node --check` on extracted script blocks, or equivalent)
- No build step, no framework — plain HTML/JS matching the `auggies-deploy` repo's style
