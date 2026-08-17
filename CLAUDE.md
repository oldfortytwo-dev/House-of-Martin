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
| `firebase.json` | Hosting + Firestore + Storage + Functions config, plus emulator ports |
| `firestore.rules` | Firestore security rules |
| `storage.rules` | Cloud Storage security rules (photo uploads) — see gotcha below |
| `functions/index.js` | Cloud Functions — weekly digest email (`weeklyDigest`, `sendDigestNow`) |
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

## Known gotcha: Firestore rules that `get()` a possibly-missing/nonexistent doc

When a security rule references another document's field — either a sibling
field that not every document has (`resource.data.someField` where older/other
docs never set it), or an entirely separate document fetched via `get()` that
might not exist yet — a bare field access throws a **Null value error** and
denies the request, even inside an `||` short-circuit that "should" never reach
it. This bit `channels/{id}` three separate ways when DM channels were added
(non-DM channels have no `participantIds` field; `canAccessChannel()`'s `get()`
on a channel that hasn't been created yet; `ensureChannelDoc`'s own existence
probe evaluating the read rule against a null `resource`). Fixes, in order:
use `.get('field', defaultValue)` instead of direct field access on a map that
might be missing the field; guard a `get()` on another document with
`!exists(path) || ...`; guard `resource.data` with `resource == null || ...`
when the rule might run against a not-yet-created document (any `getDoc()` call
used purely to check existence will do this). All three only surfaced by
testing against a real emulator with real accounts — the errors are silent
`permission-denied`s from the client's point of view with no clue which
`allow` line or which null actually failed, so when a security rule "looks
right" but a write/read still gets denied, suspect a null field access before
suspecting the boolean logic.

## Data Model

- **User** (`users/{uid}`): name, email, phone, birthdate (age shown publicly only if ≤21),
  role (member/friend/admin), status (pending/approved), householdId, inviteCodeUsed
- **Household** (`households/{id}`): name, memberIds[], responderId (RSVPs/edits for the household),
  phone, address, anniversary, extraContacts[] ({id, name, birthdate, phone, email} — family members
  with no account of their own, e.g. young kids or relatives who'll never sign up)
- **Occasion** (`occasions/{id}`): type ('birthday'|'anniversary'|'memorial'), name, month, day,
  yearRaw (2-digit string, stored as-is — never auto-expanded to a 4-digit year on import, since real
  data confirmed the same 2 digits can mean 1917 for one person's birth year and 2017 for another's
  death year; no fixed cutoff rule is reliable), deceased/deathMonth/deathDay/deathYearRaw (birthday-range entries).
  Admin bulk-imports these from a printed family calendar (Admin → Family Calendar). Optionally
  linkedUserId, or linkedHouseholdId+linkedContactId — set by Admin → "Link Calendar Birthdays to
  Contacts", which matches occasions to a User or household extraContacts entry by exact name and,
  after admin review of the guessed year, writes a real `birthdate` onto that contact and stores the
  link back on the occasion so re-matching doesn't duplicate it.
- **Branch** (`branches/{id}`): name, householdIds[]
- **InviteCode** (`inviteCodes/{code}`): role (what new signups using this code become)
- **Channel** (`channels/{id}`): name, type (family/household/branch/dm), householdId or branchId,
  invitedUserIds[] (friends). DM channels instead have participantIds[] (exactly 2 uids) and no
  `name` (display name is computed client-side as "the other participant," since the doc is shared
  between both people and can't have one fixed label) — id is deterministic,
  `dm_{sorted uidA}_{sorted uidB}`, generated by `dmChannelId()`. Unlike every other channel type,
  DM channels are genuinely restricted to their two participants at the rules level, not just hidden
  in the UI — see firestore.rules' `canAccessChannelDoc()`/`canAccessChannel()`.
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
  - `signups` subcollection (potluck-style items): item, addedBy, addedByName, claimedBy (null if
    unclaimed), claimedByName, createdAt. Any approved member/invited friend can suggest an item and
    optionally self-claim it immediately; anyone can claim an unclaimed item or release their own
    claim (never someone else's); delete is allowed for the adder, the current claimer, or an admin
    — the adder keeps delete rights even after someone else claims it, so a suggestion can always be
    retracted by whoever proposed it.
- **Album** (`albums/{id}`): title, createdBy, visibility, invitedUserIds[] (friends). Secondary to
  the Wall now — curated collections, reachable via Photos/Wall tab → "Show organized albums."
  - `photos` subcollection: url, storagePath, uploaderId, uploaderName, createdAt
- **Post** (`posts/{id}`): text, photoUrl, photoStoragePath (both null if text-only), authorId,
  authorName, createdAt, audience ('everyone'|'custom'), invitedHouseholdIds[], invitedBranchIds[],
  invitedUserIds[] — same shape and same addressing-not-access-control tradeoff as Event audience
  (see that entry above). The Family Wall (Photos tab, labeled 🧱 Wall in nav) — direct text+photo
  posting to the family (or a chosen household/branch/individual subset, shown as "Posted to: ..."
  on the card), no album required. This is the primary photo-sharing path now; Albums are
  secondary/curated, reachable via "Show organized albums."
- **DigestSubmission** (`digestSubmissions/{id}`): text, submittedBy, submittedByName,
  includedInDigestAt (null until a real — not test — digest send marks it, via Admin SDK which
  bypasses rules). Any approved member can add one from Events tab → "Add to This Week's Family Email."
- **Appearance config** (`config/appearance`, single doc): defaultThemeId (admin-set family
  default), customThemes[] (admin-built, same shape as the built-in presets — see THEME_PRESETS in
  app/index.html), bannerPhotos[] (header banner filmstrip — up to 6 {url, storagePath} objects,
  Storage path `appearance/{fileName}`; each renders as its own fixed-size cover-cropped tile in a
  horizontally scrollable row, not one stretched photo — see "Header banner" CSS). Read: any
  approved member. Write: admin-only.

## Theme System

11 built-in presets (`THEME_PRESETS` in app/index.html) spanning tame→extreme and
Facebook-mimicking→not, as asked for: Classic Family, Facebook Blue, Instagram Grid, Kraft &
Twine, Midnight Family, Retro Photo Album, Pastel Nursery, Nature/Botanical, Holographic/Neon,
Command Center, Rasta (deep green/gold/red — a tricolor gradient border-top stripe rather than
literal flag imagery, chosen as a palette/vibe like every other theme here, not caricature). Each
defines a full CSS custom-property set (colors, `--radius`, `--font-heading`/
`--font-body`) plus an animation tier (`none`/`subtle`/`glow`/`aurora`), applied instantly via
`applyTheme()` — no reload, no build step (fonts loaded once via a Google Fonts `<link>` in
`<head>`, CSS vars swapped on `:root` directly).

**Resolution order**: a member's own choice (`localStorage['hom_theme']`, per device) beats the
family default (`config/appearance.defaultThemeId`, admin-set, live-synced) beats `'classic'`.
Applied once immediately at script load — before Firebase auth even resolves — so a returning
member's sign-in screen matches what they last picked on that device, not a flash of default
then a swap.

**Every preset gets real structural divergence, not just decoration** — `renderWallFeed()`
(app/index.html) branches on `activeThemeId` for actual rendering logic, not just CSS:
- `command`: compact terminal-style log (`.wallLog`/`.wallLogLine`, `[HH:MM] AUTHOR: text`)
  instead of Facebook-style `.wallPost` cards; nav labels also lose their emoji for bracket-style
  `[tabname]` via a `<span class="lbl">` wrapper + `::before`/`::after`.
- `igGrid`: an actual 3-column square photo grid (`.wallGrid`/`.wallGridTile`), matching a real
  Instagram profile — text-only posts become a small italic quote tile in the same grid.
- `retro`: a 2-column scrapbook page (`.wallAlbumGrid`/`.wallAlbumTile`) — tilted
  polaroid-style tiles (alternating rotation) with a caption below each photo.
- `fbBlue`: profile-style post — avatar-initials circle, name/time header row, decorative
  Like/Comment/Share action row (visual only, not functional reactions — see "Deferred" below).
- `kraft`: corkboard of pinned index cards (`.wallCorkboard`/`.wallPinTile`), varied rotation via
  a 3-value rotation-class cycle, 📌 pin decoration.
- `midnight`: quiet elegant guestbook (`.wallGuestbook`) — no card boxes, a drop-cap first letter
  per entry, gold hairline dividers between posts.
- `pastel`: playful 2-column sticker masonry (`.wallStickerGrid`, CSS `columns:2`), bubble-shaped
  asymmetric-radius tiles.
- `nature`: vertical growth timeline (`.wallTimeline`) — a connecting line down the left edge,
  🌿 leaf marker per entry.
- `neon`: 2-column trading-card gallery (`.wallNeonGrid`) — reuses the plain card markup via
  `buildDefaultWallCard()`, just wrapped in a grid instead of a single column, so Neon's existing
  glass/gradient-border `.card` CSS (see per-theme signature treatments) does the visual work.
- `classic` (and any custom admin-built theme): the original single-column `.wallPost` card list,
  via `buildDefaultWallCard()`.

This was the direct answer to "themes still feel vanilla, make the non-Facebook end genuinely
different, then extend the pattern to the rest." To add another *new* preset with its own Wall
layout: keep the Firestore query/rules/compose logic identical — every branch shares
`wallDeleteHandler()` for delete+Storage-cleanup and `buildDefaultWallCard()` for the plain-card
shape where a theme just wants a grid wrapper around it — branch only `renderWallFeed()`, and rely
on the cached last snapshot (`_lastWallSnap`) so switching themes mid-view re-renders immediately
instead of waiting for the next Firestore update.

**Custom editor** (admin-only, 🎨 button in the header → "Build a custom theme"): 4 color pickers
(bg/card/ink/accent) + corner-style/heading-font/animation dropdowns. The 3 remaining tokens
(`inkSoft`, `accentSoft`, `border`) are auto-derived via CSS `color-mix()` rather than asking for
3 more pickers — e.g. `border: color-mix(in srgb, ${ink} 14%, ${bg})` — set directly as the CSS
custom property's *value string* (not resolved in JS), so the browser computes the actual color at
render time. Saved themes append to `config/appearance.customThemes[]` and immediately become
selectable/family-default-able by everyone, indistinguishable from a built-in preset to the rest
of the app.

**Banner photo**: admin-only upload (Storage `appearance/{fileName}`, mirrors the `albums/`
Storage trust boundary — see that rule's comment in storage.rules for why cross-service admin
checks aren't attempted there). Shown as a full-width image above the topbar when set. This is
the first "photo insertion point"; per-theme decorative photo framing (e.g. Kraft & Twine's
scrapbook/polaroid corners) was intentionally left for a future pass rather than building bespoke
treatments for all 10 themes in one push.

Verified end-to-end against the emulator: admin's family-default write persisted and a non-admin
correctly inherited it live, the same non-admin was correctly denied writing `config/appearance`
directly, and a personal `localStorage` override correctly beat the family default on reload
(including pre-login).

## Weekly Digest Email (Cloud Functions)

`functions/` — first Cloud Functions codebase in this project, deployed separately from
hosting/rules: `firebase deploy --only functions --project house-of-martin`. Requires the
Blaze plan (already on it, since Storage needed it) and, one-time, enabling the Secret
Manager API by hand via the console (same class of manual step as Storage's "Get Started" —
`firebase deploy --only functions` will fail with a 403 pointing at the enable URL the first
time; retrying after enabling it works immediately, no propagation delay observed).

- `weeklyDigest`: scheduled, Mondays 8am America/New_York. Emails every approved member —
  upcoming birthdays/anniversaries (next 7 days, from `occasions`), upcoming events (next 7
  days), and any open `digestSubmissions` (marked included after sending).
- `sendDigestNow`: admin-only callable (checks the caller's Firestore `users/{uid}` doc — Admin
  SDK bypasses `firestore.rules` entirely, so this check is manual, not automatic). Accepts an
  optional `{ testEmails: [...] }` — when present, sends only to those addresses instead of the
  real family list, and does **not** mark submissions as included, so a test run is repeatable
  and never spoils a surprise send to the whole family. The Admin tab's UI exposes this as two
  separate buttons ("Send test to those emails only" vs. a confirm-gated "Send the real digest").
- Sent via Gmail SMTP (nodemailer), not a third-party email service — fine at family-list volume
  (well under Gmail's ~500/day limit). Credentials are two Firebase secrets, `GMAIL_USER` and
  `GMAIL_APP_PASSWORD` (a Google Account "App Password," requires 2-Step Verification already on;
  the App Passwords page is no longer linked from the main Security settings page — go straight to
  `myaccount.google.com/apppasswords`). **Never set secret values via the Bash tool or by asking
  the user to paste them in chat** — `firebase functions:secrets:set NAME --project house-of-martin`
  must be run by the user in their own terminal, since the CLI's prompt hides the input and there's
  no way to relay a hidden interactive prompt through this session. After setting/rotating a secret,
  redeploy functions for it to take effect.
- Verified end-to-end against the emulator before real secrets existed: seeded a fake
  `functions/.secret.local`, confirmed a non-admin's call was denied in ~2ms (before touching
  Firestore), and confirmed an admin's call correctly built digest content from seeded
  occasions/events/submissions and reached real Gmail SMTP servers, failing only with a legitimate
  "bad credentials" rejection — proof the whole pipeline was correct before real credentials were
  wired in. `.secret.local` is gitignored (`*.local`) and was deleted after testing.

## Auto-approval on known email (Cloud Function) + reactive auth flow

`autoApproveKnownEmail` (Firestore trigger on `users/{uid}` create, first Firestore-triggered — as
opposed to scheduled/callable — function in this project; its first deploy failed with an Eventarc
permission-propagation error and succeeded on retry ~90s later, same class of "first time" delay as
other Google Cloud API enablement in this project) — if a new signup's email matches an email
already on file in any household's `extraContacts`, they're auto-approved and linked into that
household immediately, and the now-redundant `extraContacts` entry is removed. No match leaves them
`pending` for the normal manual review. Documented security tradeoff in the function's own comment:
Firebase Auth doesn't verify email ownership on signup, so this trades a bit of rigor for a lot of
admin convenience — consistent with this app's existing posture elsewhere (e.g. storage.rules'
albums/ comment), but worth knowing if the invite code ever circulates beyond trusted family.

This surfaced a real pre-existing gap: the pending→approved transition (`onAuthStateChanged` in
app/index.html) used to be a **one-time** `getDoc`, not a live listener, so nobody — auto-approved
or manually approved via the admin Pending Approvals button — would actually see the app until they
refreshed. Fixed by converting it to a live `onSnapshot` on the signed-in user's own doc, guarded by
a `_shellInitialized` flag so the various `init*()` calls still only fire once per session rather
than re-subscribing everything on every unrelated profile-doc change. Verified with three separate
emulator signups, including a "sign up and just wait" test that flipped from the pending screen to
the full shell live and unprompted in under 5 seconds, no refresh.

## Roles & Privacy

- **Admin**: approve members/friends, manage households/branches, generate invite codes, full visibility,
  promote/demote other admins (Admin tab → Staff & Roles). Multiple admins are fully supported — `role`
  is just a field, nothing in rules or code assumes a single admin. Self-demote is hidden in the UI to
  prevent accidental lockout (a *different* admin has to do it, or edit Firestore directly if you're
  down to one).
- **Member**: full access to family/household/branch channels, directory, events, photos; can RSVP for self or household (if responder)
- **Family friend**: access limited to specific invited channels/events/albums only — no full directory, no unrelated content

## MVP Scope (Phase 1) — status

**Built:** invite-code-gated signup + admin approval, households/branches with
"respond as a family" RSVP, family/household/branch messaging channels, event
RSVP with live counts and customizable invite audience, contacts directory
grouped by household, real photo upload to Storage, age badges (≤21) with
self/admin-editable birthdate, Family Calendar (birthdays/anniversaries/death
anniversaries) with contact linking, Share button (native share sheet +
Facebook/copy fallback), household self-service editing for the responder
(Contacts tab → "Edit My Household" — phone/address/anniversary/responder
handoff/extraContacts; member add-remove and moving a contact to a *different*
household stay admin-only since those touch documents the responder doesn't
own), DM channels (genuinely private, not just UI-hidden — see the Firestore
rules gotcha above), weekly digest email (Cloud Functions — see section above),
multi-admin role management, admin Dashboard (live counts + estimated costs),
11-preset theme system with personal/family-default resolution, admin custom
theme editor, header banner photo filmstrip, and potluck-style event sign-up
lists (see "Theme System" section above and Data Model below).

**Deferred:** family tree view, native app wrapper,
deactivating a real account holder's login (vs. the deceased-toggle already
built for no-account extraContacts), functional Wall reactions/comments (Facebook
Blue's Like/Comment/Share row is decorative only — no `likedBy` field or comments
subcollection exists yet), profile pictures (members currently only get initials
avatars on Facebook Blue's Wall posts — no photo-upload field on the user doc,
no avatar shown anywhere else in the app: Contacts rows, DMs, other Wall themes).

## Working Style / Preferences

(Carried over from the developer's other project — apply here too.)

- Prefer diagnosing root cause over patching symptoms
- Surgical, precise edits — verify exact anchor text before replacing
- Syntax-check JS after edits (`node --check` on extracted script blocks, or equivalent)
- No build step, no framework — plain HTML/JS matching the `auggies-deploy` repo's style
