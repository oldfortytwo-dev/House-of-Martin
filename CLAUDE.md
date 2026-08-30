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
| `app/push-sw.js` | Service worker for Web Push background notifications — see "Push notifications" below |
| `firebase.json` | Hosting + Firestore + Storage + Functions config, plus emulator ports |
| `firestore.rules` | Firestore security rules |
| `storage.rules` | Cloud Storage security rules (photo uploads) — see gotcha below |
| `functions/index.js` | Cloud Functions — weekly digest email, push notifications, auto-approval |
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
  photoUrl (profile picture, Storage path `avatars/{fileName}`; falls back to a deterministic
  colored initials circle everywhere via `avatarHtml()` when not set — selecting a photo in the
  Edit Info modal opens a crop/zoom tool first, see "Photo crop tool" below, rather than uploading
  the raw file), role (member/friend/admin), status (pending/approved/deactivated — see "Account
  deactivation" below), householdIds[] (array, not a single value — see "Multi-household
  membership" below; `userHouseholdIds(u)` is tolerant of old docs that still only have the
  pre-migration singular `householdId`), inviteCodeUsed, deactivatedAt (null unless status is
  'deactivated'), pushSubscriptions[] ({endpoint, keys:{p256dh,auth}} — one per device/browser
  with push notifications enabled, see "Push notifications" below)
- **Household** (`households/{id}`): name, memberIds[], responderId (RSVPs/edits for the household),
  phone, address, anniversary, contactIds[] (reverse index into the `contacts` collection below —
  no-account family members belonging to this household; renamed from the old embedded
  `extraContacts[]` array on 2026-08-23, see "Multi-household contacts")
- **Contact** (`contacts/{id}`): name, birthdate, phone, email, deceased, householdIds[] (a contact
  can belong to more than one household, same shape as User's `householdIds` — see "Multi-household
  contacts" below), createdBy, createdAt. Promoted 2026-08-23 from `households/{id}.extraContacts`
  to its own top-level collection for exactly the reason `householdId`→`householdIds` did on User:
  an embedded/single-parent field can't represent "belongs to two households at once."
- **Occasion** (`occasions/{id}`): type ('birthday'|'anniversary'|'memorial'), name, month, day,
  yearRaw (2-digit string, stored as-is — never auto-expanded to a 4-digit year on import, since real
  data confirmed the same 2 digits can mean 1917 for one person's birth year and 2017 for another's
  death year; no fixed cutoff rule is reliable), deceased/deathMonth/deathDay/deathYearRaw (birthday-range entries).
  Admin bulk-imports these from a printed family calendar (Admin → Family Calendar). Optionally
  linkedUserId, or linkedContactId — set by Admin → "Link Calendar Birthdays to Contacts", which
  matches occasions to a User or `contacts` entry by exact name and, after admin review of the
  guessed year, writes a real `birthdate` onto that contact and stores the link back on the occasion
  so re-matching doesn't duplicate it.
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
  (see that entry above). reactions ({uid: 'like'|'love'|'haha'|'wow'|'sad'|'angry'} — six
  Facebook-style reaction types, see "Reactions" below; replaced the original plain likedBy[]
  array). The Family Wall (Photos tab, labeled
  🧱 Wall in nav) — direct text+photo posting to the family (or a chosen household/branch/individual
  subset, shown as "Posted to: ..." on the card), no album required. This is the primary
  photo-sharing path now; Albums are secondary/curated, reachable via "Show organized albums."
  - `comments` subcollection: text, authorId, authorName, createdAt. Any approved member can add
    one; delete is author-or-admin. Lazy-subscribed only when a viewer expands a post's comment
    section (not eagerly for every post in the feed).
- **Notification** (`notifications/{id}`): forUserId (recipient), fromUserId, fromUserName, type
  ('reaction'|'comment'), postId, reactionType (reaction notifs only), textPreview (comment notifs
  only, first 80 chars), createdAt, read. See "Notifications" below.
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

**Reactions/Comment/Share work identically across all 9 layouts**, not just Facebook Blue — the
same shared pieces get dropped into every branch: `reactionsBlockHtml(p)` (compact reaction
button + count, 💬 toggle, 🔗 share — used by the 7 space-constrained layouts) or the labeled
`.fbActions` markup (Facebook Blue and the default/Neon card) for the HTML, and
`wireLikeAndComments(container, id, p)` to wire it up afterward (finds `.wallLikeBtn`/
`.wallReactMore`/`.wallReactPicker`/`.wallCommentToggle`/`.wallPostShareBtn`/`.wallCommentSection`
by class within whatever `container` you pass it — a tile, a card, a log-line wrapper, doesn't
matter). Comments are lazy-subscribed only when a viewer actually expands a post's comment
section, not eagerly for every post in the feed. Two layouts needed structural adjustment
to make room: `command`'s log-line got wrapped in a `.wallLogEntry` div per entry (the comment
section needs a block-level home to expand into, and `:last-child` border-removal had to move from
the line to this new wrapper accordingly), and `igGrid`'s tile split its fixed `aspect-ratio:1` into
an inner `.wallGridMedia` div so the tile itself can grow to fit reactions without distorting the
photo crop. Share calls the same `shareContent()` used by Event cards and individual photos (native
share sheet, or the Facebook/copy fallback modal) via a small `shareWallPost(p)` wrapper.

**Reactions** (`likeButtonHtml()`/`REACTIONS`): six Facebook-style types — Like 👍, Love ❤️, Haha
😂, Wow 😮, Sad 😢, Angry 😡 — stored as `posts/{id}.reactions`, a `{uid: type}` map (replaced the
original plain `likedBy[]` array). Each post's reaction control is two buttons plus a popover:
tapping the main button is a quick toggle (adds/removes a plain Like, or switches your existing
reaction to Like); tapping the small "▾ " button next to it opens a 6-emoji picker
(`.wallReactPicker`) to react with something else, switch, or tap your current reaction again to
remove it. The "▾" button itself also shows the top few distinct reaction emojis present on the
post plus the total count (Facebook's small aggregate-summary convention). Only one open picker
at a time — opening one closes any other, and a delegated `document` click listener closes an
open picker when you tap anywhere outside `.wallReactWrap`.

`setReaction(postId, type, currentReactions)` writes the *whole* map back (spread the existing
object, set-or-delete just the caller's own key) — safe because the matching `firestore.rules`
clause enforces the restriction server-side: `request.resource.data.reactions.diff(resource.data
.get('reactions', {})).affectedKeys().hasOnly([request.auth.uid])`, i.e. the map's *actual
changed keys* (not just the keys present) must be exactly the caller's own uid, so a client can't
overwrite anyone else's reaction by including their key unchanged in the same write, and definitely
can't change it. Verified against the emulator, including a false-positive caught and re-tested
properly: a non-admin, non-author account was correctly denied changing another user's reaction
to a genuinely different value; an earlier same-value overwrite attempt had appeared to "succeed"
only because it was a no-op diff (identical value in, identical value out — Firestore rules'
`hasOnly([])` on an empty changed-keys set is vacuously true), not a real hole — re-tested with a
value actually different from the current one and correctly denied. Setting/changing/removing your
own key succeeded in all cases; sneaking a `text` field edit into the same write was denied.

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

**Dark-theme form-field contrast**: `applyTheme()` computes a luminance check on the theme's `bg`
color (`isDarkColor()`) and sets the CSS `color-scheme` property (`dark`/`light`) on `:root`
accordingly. This isn't cosmetic — without it, some mobile browsers' forced-dark-mode heuristics
(confirmed on Android Chrome) decide independently that unrecognized form fields need re-coloring,
and get it wrong inconsistently, which is what caused a reported "hard to read" bug on Rasta's Edit
Info form. `color-scheme` tells the browser the page already handles dark mode correctly so it
backs off. Inputs/selects/textareas also got explicit `color`/`background`/`-webkit-appearance:none`
as defensive backup, but `color-scheme` was the actual fix — if a future theme has readability
complaints again, check this before assuming it's a plain contrast/color-token problem.

**Photo crop tool** (`#cropModalBg`, opens from the Edit Info modal's "Change photo" instead of
uploading the picked file directly): drag-to-pan + slider/wheel-to-zoom (1x-3x) against a circular
guide overlay, always exports a 400x400 JPEG via canvas regardless of the source image's own
dimensions/aspect ratio. The crop math tracks its own pan/zoom state (`_cropState`) rather than
reading back rendered CSS transform values — `sx = -imgLeft/scale`, `sy = -imgTop/scale`,
`sSize = min(viewport/scale, remaining source width, remaining source height)`. Verified by
dispatching a real file-input change event with a synthetic two-color test image (not a
reimplementation of the math): the initial centered transform matched the hand-derived cover-fit
formula exactly, and decoding the final cropped output showed sampled pixels landed exactly where
the formula predicted.

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
  **Gated by `config/appearance.digestEnabled` — strict opt-in, defaults to paused.** The
  schedule fires unconditionally every Monday regardless of whether anyone's configured
  anything; the function checks this field and no-ops unless it's explicitly `true` (missing
  field or `false` both mean paused). This exists because the feature almost emailed the whole
  family mid-testing — the Monday after it was built arrived before the admin had touched the
  toggle. `sendDigestNow` (test sends and the manual real-send button) is **not** gated by this;
  those are already explicit admin actions. Admin tab has a checkbox reflecting/writing this
  field live.
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
already on file in the `contacts` collection, they're auto-approved and linked into **every**
household that contact belonged to (rewritten 2026-08-23 for multi-household contacts — a contact
can now be in more than one household, so a match auto-approves into all of them, not just one),
and the now-redundant `contacts` doc is deleted. No match leaves them `pending` for the normal
manual review. Documented security tradeoff in the function's own comment:
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

## Contacts layout

Redesigned in response to real feedback (screenshots): the old Contacts tab was a flat list —
every household and every person always fully expanded, no visual separation between households,
and no-account contacts (`extraContacts`) had zero interactivity while real accounts were
clickable but with no visible affordance that they were. The "Edit My Household" form also used
to sit permanently expanded at the top of the tab regardless of whether you wanted it open,
pushing the actual directory down.

- **"Edit My Household" moved from an always-expanded inline card to a modal**, opened by a
  "🏠 Edit My Household" button (visible only to the household's responder, same visibility rule
  as before) sitting next to the existing "🌳 View Family Tree" button. Same pattern as Family
  Tree/Notifications/Profile — nothing new to learn, and it stops eating vertical space when
  nobody asked to see it.
- **Three selectable Contacts layouts**, chosen via `getTheme(activeThemeId).contactsLayout`
  (`renderContacts()`), defaulting to `'accordion'` for every built-in preset:
  - **Accordion** (default) — each household collapses to a summary row (avatar stack, name,
    address/people-count subtitle); tap to expand. Solves the density complaint directly.
  - **Cards** — every household is its own bordered card, all visible at once, just with clearer
    separation than the old flat divided list.
  - **Grid** — larger photo-forward avatar tiles in a 3-column grid per household.
  All three are real components (`renderContactsAccordion()`/`renderContactsCards()`/
  `renderContactsGrid()`), not mockups — built from a shared `contactsGroupedData()` (same
  household-grouping logic the old single renderer used) and a shared `personLinkHtml()` helper
  so real accounts and no-account contacts render consistently across all three layouts.
- **Every person is now clickable, real account or not** — this was the other half of the
  complaint ("contacts are not clickable"). Real accounts open the existing profile page
  (`.profileLink`, unchanged). No-account contacts open a new lightweight `openContactDetail()`
  modal (`.contactDetailLink`) showing name/age/deceased-marker/phone/email, with a hint pointing
  authorized viewers (the household's responder, or any admin) to the existing edit surface —
  `renderMyHousehold()`'s modal for the responder, or Admin → Households for an admin editing a
  household they don't belong to — rather than building a third extraContacts editor from
  scratch (two already existed).
- **The three inline icon buttons (✎ Edit / 💬 Message / 🚫 Deactivate) were removed from every
  Contacts row** and consolidated onto the profile page's action row instead (`openProfile()`
  already had Edit/Message; Deactivate was added there in this pass). This was a deliberate
  declutter — three icon buttons on every single row was exactly the "elementary"/busy feeling
  flagged in review — not just a rename. A person's own profile is a more natural home for
  "do something to this person" than the directory row is.
- **Custom themes can override the layout** via a new "Contacts layout" `<select>` in the theme
  editor (`#teContactsLayout`), wired through `draftThemeFromEditor()`/`teSaveBtn`/
  `openThemeEditorBtn` the same way every other per-theme field already was. Built-in presets
  don't get per-preset layouts hand-tuned (unlike Wall, which has bespoke layouts per preset) —
  they all use the `'accordion'` default; only admin-built custom themes can pick something else.
  Live preview works correctly even for the in-progress unsaved draft theme (which isn't in
  `customThemes` yet) via an optional `themeOverride` param on `renderContacts()`.
- Verified against the emulator: accordion is the actual default with no custom theme created;
  expand/collapse works; a real account's `.profileLink` correctly opens its profile page
  (own-profile view has no Message/Deactivate, viewing an admin viewing another member correctly
  shows all three actions); a no-account contact's `.contactDetailLink` correctly opens the detail
  modal with the right household-specific edit hint; the "Edit My Household" modal opens/closes
  correctly; the theme editor's Contacts-layout picker previews live (accordion → grid → cards all
  confirmed rendering the right component with the right item counts), persists through save, and
  survives a full page reload.

## General polish pass (2026-08-22)

Following an actual audit of the app's screens (not a specific bug report — Ryan's "app feels
clunky" assessment, so this session did the evaluation itself rather than waiting for a list).
Screenshots weren't rendering in the local Browser tool that day, so the audit was done
structurally instead — reading the actual DOM/CSS for each tab, which is at least as reliable
given this codebase was already being read/written directly all session. Three concrete,
unrelated findings, all fixed:

- **Composer/form cards permanently pinned above content, in two more places** — the same root
  issue already fixed once for "Edit My Household" (see "Contacts layout" above) turned out to
  recur: the Events tab's "📣 Add to This Week's Family Email" form and the Wall tab's post
  composer both sat permanently expanded above the actual content (events list / Wall feed),
  pushing what people came for below a form most visits don't need. Both converted to the same
  collapsed-button-opens-a-modal pattern: `#openDigestBtn`/`#digestModalBg` and
  `#openWallComposerBtn`/`#wallComposerModalBg`. The digest button also grows a pending-count
  badge (`renderDigestSubmissions()` sets its text), and posting from the Wall modal now closes
  it automatically on success instead of leaving it open.
- **Reaction buttons visually duplicated themselves** — on a post you'd reacted to, the trigger
  button ("❤️ Love") and the "more/picker" button ("❤️ 1▾") showed the *same* emoji right next
  to each other, reading as a glitch rather than two distinct controls. Fixed in
  `likeButtonHtml()`: the "more" button now only surfaces *other* people's top reaction emoji
  (subtracting the viewer's own from the tally first) — if everyone who reacted picked the same
  type the viewer did, there's nothing left worth calling out separately, so it just shows the
  count.
- **Event cards had no visual hierarchy** — title, when/where, host, invited-audience, your
  RSVP, the household RSVP block, RSVP counts, and the potluck sign-up section all sat at equal
  visual weight in one long stack. Added a "Your RSVP" label above the individual RSVP row for
  context, and gave the household-RSVP block and potluck section a tinted, rounded sub-card
  treatment (`.eventCard .hhRsvpBlock, .eventCard .ecSection` — deliberately scoped to
  `.eventCard` specifically, since the underlying `.ecSection`/`.hhRsvpBlock` classes are reused
  in several unrelated contexts like the household editor and admin panel that shouldn't pick
  this up) instead of just a dashed divider line, so the card reads as distinct grouped sections.
- Verified against the emulator: both composer modals open/close correctly and the digest badge
  count updates live; posting from the Wall modal closes it and the new post appears in the feed
  immediately; the reaction fix confirmed directly in the rendered feed (Bob's post, reacted to
  by Ryan with "love", correctly showed "❤️ Love" / "1▾" with no duplicate heart); no new
  console errors beyond the already-documented pre-existing transient reload-race pattern.

### Admin tab audit (2026-08-22, same day, follow-up pass)

By far the single biggest density problem in the app, found and fixed once Ryan asked for the
Admin tab specifically: **11 always-expanded cards stacked in one flat list, measuring ~4,736px
tall on a phone viewport (812px) — nearly 6 full screens of scrolling** to reach the bottom
(Branches), with no grouping between things checked constantly (Pending approvals) and things
touched once during initial setup (bulk-import tools).

- Every card in `#pane-admin` converted from `<div class="card">` to `<details class="adminAcc">`
  — a title + chevron `<summary>` with the rest of the card's content in `.adminAccBody`, same
  collapse-on-demand idea as the Contacts accordion but with new, admin-specific CSS classes
  (`.adminAcc`/`.adminAccBody`) rather than reusing the Contacts-specific `.accHousehold` ones.
  **Ryan explicitly chose defaults by actual usage frequency** (one of three options presented):
  Dashboard, Staff & Roles, and Pending approvals default **open** (checked often); Deactivated
  accounts, Invite codes, Weekly Digest Email, Family Calendar bulk import, Address Book bulk
  import, Link Calendar Birthdays, Households, and Branches default **collapsed** (one-time setup
  or occasional-use tools).
- Result: scroll height dropped to ~1,976px (under 42% of the original) with the three
  high-frequency cards still visible without any taps.
- The Households card's own internal per-household accordion (`renderHouseholdsAdmin()`'s
  `expandedHouseholdIds`, pre-existing) now sits nested inside the new outer accordion — verified
  this still opens/closes correctly and doesn't fight with the outer `<details>`.
- No JS changes were needed beyond the HTML restructure — every card's existing functionality
  (invite code creation, household editing, etc.) was verified working unchanged inside the new
  collapsed/expanded shell.
- Verified against the emulator: default open/closed states matched exactly what was specified;
  invite-code creation and the nested household editor both still worked correctly inside their
  accordions; no new console errors.

## Accessibility: broken checklist checkboxes + "Large text & photos" (2026-08-22)

Ryan reported the multi-household checklist felt "clunky and not selectable," and separately
asked for larger text and profile pictures "for us old folks." The checklist complaint turned
out to be a real **CSS bug**, not a preference — found by inspecting the actual computed styles,
not guessed at:

- **Root cause**: the generic rule `.field input, .field select { width:100%; ...
  appearance:none; }` was written for text/select inputs, but every `.chkGroup` checklist
  (household picker, branch picker, admin member picker) happens to sit inside a `.field` div
  too, so its checkboxes inherited `width:100%` (stretched to fill the row) and
  `appearance:none` (which strips the native checkbox's visible box entirely) — they were
  rendering essentially invisible and stretched, not just small. Fixed by excluding checkboxes
  from that rule (`:not([type=checkbox])`).
- **On top of the fix**, `.chk`/`.chkGroup` were also resized for real touch-friendliness: 22×22px
  checkboxes (was inheriting whatever the broken rule left, effectively unusable) with
  `accent-color: var(--accent)` to recolor the *native* checkbox rather than replacing it with a
  fully custom-built toggle (keeps built-in keyboard/screen-reader accessibility for free), plus
  a `:has(input:checked)` rule that highlights the *entire row* when checked — far easier to see
  at a glance than a small checkmark alone, and a harmless no-op on the rare browser without
  `:has()` support.
- **"Large text and profile pictures" solved as one combined personal preference**, not two
  separate features: a "🔠 Large text & photos" checkbox in the Theme picker modal
  (`#largeTextToggle`, next to the existing personal theme override — same `localStorage`
  pattern, key `hom_largeText`) that toggles a `body.large-text` class using CSS `zoom: 1.22`.
  This was a deliberate architectural call: nearly every font/spacing/image size in this
  stylesheet is a fixed px value, not rem, so a `body { font-size }` bump wouldn't cascade to any
  of it — rewriting the whole stylesheet to relative units to support one toggle wasn't worth it.
  `zoom` scales the *entire rendered page* — text, buttons, checkboxes, and avatars — as one
  unit. Not supported in Firefox (harmlessly stays default size there — this app's real-world
  usage is iOS Safari + Chrome, both of which support `zoom`).
- **Follow-up same day**: Ryan tried it and reported "didn't notice much of a difference with
  profile pictures." Measured directly rather than guessed — the zoom math was exactly right
  (a 26px avatar measured 31.7px rendered, precisely ×1.22), but a ~6px absolute change on
  something that starts this small just isn't a noticeable jump, especially for the audience this
  was built for. Since photos specifically were the ask, `avatarHtml(name, photoUrl, size)` now
  reads `document.body.classList.contains('large-text')` at render time and requests **1.5× the
  base size outright** when active — which then *also* gets the page zoom on top of that
  (1.5 × 1.22 ≈ 1.83× total), a deliberate disproportionate boost for avatars specifically, not
  just "everything a little bigger." Since `avatarHtml()`'s output is baked into already-rendered
  HTML, toggling large-text now also calls `renderContacts()`/`rerenderWallFeed()` immediately
  (same re-render-on-preference-change pattern already used for theme switches) so on-screen
  avatars update right away instead of waiting for their next natural re-render.
- Verified against the emulator: a checkbox's computed style went from the broken state to a
  real 22×22px native checkbox with `appearance:auto` and the correct accent color, and its row
  visibly highlights when checked; the large-text toggle applies `zoom:1.22` immediately, persists
  across a full reload (confirmed applying even pre-login, matching the existing theme-override
  behavior), correctly reflects its saved state when the Theme modal is reopened, and toggles back
  off cleanly; a Contacts avatar measured 32px with large-text off and **58.5px with it on** (the
  full compounded 1.5×1.22 boost), confirmed via direct before/after `getBoundingClientRect()`
  measurement, not just eyeballing.

## Households & Branches — how it actually works

Came up because the model wasn't obvious from using the app — worth re-reading before touching
this area again, and worth re-explaining to the user if it comes up.

- A **household** is a family unit sharing an address (e.g. "The Alvarez-Martins"). It has
  members (real accounts), an optional list of no-account family members (`contactIds`, e.g.
  young kids — see "Multi-household contacts" below for why this used to be called
  `extraContacts`), a responder, and shared contact info.
- A **branch** is a group of *households* (e.g. "Descendants of Grandpa Joe"), not a group of
  people. You don't join a branch directly — your household does, and you're in it by extension.
  This is the part that's confusing on first read: there's no "add yourself to a branch" concept
  at the person level by design, only "which branch(es) does my household belong to."
- **A person can belong to more than one household at once** (added 2026-08-22, in response to a
  real scenario: a divided family where a kid genuinely has two homes). `users/{uid}.householdIds`
  is an array, not a single value — see the "Multi-household membership" section right below for
  the full mechanics. **No-account family members (`contacts/{id}`) got the same ability the very
  next day** (2026-08-23) — see "Multi-household contacts" further below.
- **Only a household's responder can pick which branch(es) it belongs to** — from Contacts →
  "Edit My Household" → the branch checklist. This is deliberately at the household level, not
  the person level, matching the model above.
- **Regular members can't create/manage branches themselves** — only assign their own household
  to existing ones. Creating a new branch is still Admin → Branches (an admin-only concept, since
  a branch groups multiple households together and needs someone with a bird's-eye view).
- **Branch self-toggle membership goes through a Cloud Function** (`updateBranchMembership`,
  `functions/index.js`), not a client-side rules path. Two things were tried and failed here before
  landing on this: first, a rule keyed off the pre-multi-household singular `me().householdId`
  field, silently broken for anyone who only ever had `householdIds` populated. The attempted
  replacement (2026-08-23) tried to derive "the one household id that changed" from a Set-difference
  of the old/new `householdIds` array, then look that id up with `get()` — this is fundamentally
  impossible in Firestore's rules language: `Set` has no `.toList()` or indexing method, so a value
  that's been put into a Set can never be pulled back out as a scalar to plug into a `get()` path,
  and there's no loop construct to check "for every changed id" as an alternative. Discovered via a
  real permission-denied error against the emulator (`Name: [toList]. for 'update' @ L80`), not by
  reading the docs first — worth remembering next time a rule needs "the one thing that changed" out
  of a diffed array. `branches/{branchId}` in `firestore.rules` is admin-only write now; the Cloud
  Function does the same responder-or-admin check in ordinary JS and writes via the Admin SDK, which
  bypasses rules entirely — same shape as `updateHouseholdMembership` for the analogous
  third-party-doc-write problem below.

### Multi-household membership — the mechanics

- **Source of truth**: `users/{uid}.householdIds` (array) forward, `households/{id}.memberIds`
  (array) reverse — both kept in sync on every write, same two-sided pattern already used
  elsewhere in this data model. `userHouseholdIds(u)` is the one helper every read site goes
  through; it's tolerant of the pre-migration singular `householdId` field (old data — including
  anything written before this date — keeps working with zero backfill needed, no migration
  script was run or is needed).
- **Self-service (Edit Info modal, own account or admin-editing-anyone)**: the old single
  `<select>` "Household" dropdown is now a checkbox checklist (`#epHouseholdChecklist`) — check
  or uncheck any number of households, plus a separate "Create a new household…" button that
  commits immediately (writes the household **and** updates the creator's own `householdIds` in
  the same action, rather than waiting for the outer Save — a real bug caught in testing: Create
  followed by Cancel used to leave the household listing the creator as a member while the
  creator's own record didn't list it back). Saving reconciles the checklist against what was
  checked before: one `households/{id}` doc update per household whose state actually changed,
  each touching *only* that person's own presence in that one array — this is the same
  self-toggle-safe shape the branch checklist already used, so **no `firestore.rules` changes
  were needed** for this whole self-service path, multi-household or not.
- **A household's responder can add or remove an *existing* account holder** too — Contacts →
  "Edit My Household" → "Members with an account" section, a dropdown of every approved member
  not already in that household plus a "✕" next to each current member (except the responder,
  who has to be reassigned first — same guard the demote-admin UI uses elsewhere). This is the
  one piece that genuinely needed a Cloud Function (`updateHouseholdMembership`,
  `functions/index.js`): it writes to a *third party's* own `users/{uid}.householdIds`, and
  `firestore.rules` only ever lets that person themselves (or an admin) write their own doc — a
  responder is neither for someone else's account, so there's no safe client-side rules path for
  this specific direction. The function checks the caller is the household's current responder
  or an admin, then does both sides of the write (`households/{id}.memberIds` +
  `users/{uid}.householdIds`) in one atomic batch so they can never drift apart.
- **If someone is the responder of more than one household**, "Edit My Household" shows a
  household switcher (`#mhWhichHousehold`) at the top of the modal instead of just opening the
  one; remembers which one was open across re-renders.
- **Everywhere a household's member list is read fans a multi-household person out correctly**:
  Contacts shows them under *every* household they're in (by design — Contacts answers "who's in
  this household," and someone genuinely can be in more than one); the profile page lists every
  household plus the union of all their branches; the Messages tab shows a household chat pill
  per household; RSVP-by-household on an event shows one "RSVP for the whole X household" block
  per household the viewer is the responder of. Family Tree needed **no changes** for the
  fan-out — it was already driven by `household.memberIds` (the reverse index), which naturally
  already supported one person appearing under several household nodes.
- **Admin → Households' member checkbox editor** no longer treats household membership as
  exclusive — checking someone in used to silently *remove* them from whatever household they
  were previously in (a real single-household-enforcement behavior from before this change);
  now it only ever adds/removes *this* household from their own `householdIds`, leaving any other
  households they belong to untouched. Deleting a household from this panel likewise only strips
  that one household from each member's `householdIds`, not their entire household list.
- Verified against the emulator end-to-end: a person seeded into two households fanned out
  correctly in Contacts, Family Tree, and the Messages household pills; the responder-of-multiple
  household switcher; adding/removing an existing member via the Cloud Function (confirmed both
  sides of the write, not just the household side); the self-service checklist adding *and*
  removing households (including admin-editing-someone-else); Create-then-Cancel no longer
  leaving a one-sided membership (caught and fixed mid-testing); and the Admin → Households
  checkbox toggle correctly leaving a person's *other* household membership untouched when
  toggling a different one. One real bug was caught and fixed during this pass: the "add existing
  member" success/error status message wrote to a DOM element that the live households listener
  had already removed by the time the async call resolved (the write succeeding is what triggers
  the re-render) — fixed by null-checking before writing to it, a pattern already used elsewhere
  in this file for the same reason.

### Multi-household contacts — the mechanics (2026-08-23)

The morning after multi-household landed for real accounts, the user asked why Admin →
Households' member checklist only offered the 3 real-account family members as options — the
answer was that no-account family members (Grandma Rose, etc.) had no equivalent capability at
all, and the user confirmed they wanted full parity: everyone in the family checklist, real
account or not, regardless of account status.

- **`contacts/{contactId}` is now its own top-level Firestore collection**, promoted from the old
  `households/{id}.extraContacts` embedded array — the exact same reason `users/{uid}.householdIds`
  became an array instead of a single `householdId` field: an embedded/single-parent field can't
  represent "belongs to more than one household at once." A contact now carries its own
  `householdIds` array (forward index) and each household carries `contactIds` (reverse index),
  mirroring the real-account pattern exactly. `familyContacts`/`contactsById` (client-side) mirror
  `allApprovedUsers`/module state the same way.
- **No Cloud Function needed for the contact side** (unlike `updateHouseholdMembership` for real
  accounts) — a contact has no self-identity to protect (nobody signs in *as* a contact), so
  `firestore.rules`' `contacts/{contactId}` block is deliberately wide open to any approved member
  for create/update/delete, same low-security/high-convenience posture already used for `albums/`.
  Adding/removing a contact from a household is a plain two-sided `writeBatch` from the client.
- **The self-service "add someone" dropdown (Contacts → Edit My Household) now branches on type**:
  `value="user:{id}"` goes through `updateHouseholdMembership` (still needs the Cloud Function,
  since writing someone else's `users/{uid}` doc still requires being that user or an admin);
  `value="contact:{id}"` is a plain client batch write (no third-party-owned doc involved).
- **Every read site that used to read `household.extraContacts` now reads the `contacts`
  collection** filtered/fanned-out by `householdIds`, matching the real-account fan-out pattern:
  Contacts tab, Family Tree, the contact detail modal (now shows every household a contact belongs
  to, not just one), Admin → Households' unified member checklist (real accounts and contacts
  together, in one list — the user's original ask), and the self-service household editor.
- **Two flows that write `contacts` outside the household editors were also converted**: the
  address-book bulk import (Admin → Households) generates the new household's Firestore doc ID
  client-side up front, specifically so newly-created contacts in the same paste can reference a
  household that hasn't been written yet — same one-shot create-or-update shape as before, just
  targeting the new collection. The calendar-birthday-linking tool (matching `occasions` entries
  to people by name) matches/writes against `contacts` the same way; a matched no-account birthday
  now sets `linkedContactId` instead of the old `linkedHouseholdId` (dropped — a contact's identity
  no longer implies a single household).
- **A real pre-existing rules bug was found and fixed while building this**: `branches/{branchId}`'s
  self-toggle rule was still keyed off `me().householdId`, the pre-multi-household singular field —
  see the "Branch self-toggle membership" bullet above for the full story of what replaced it.
- Verified against the emulator end-to-end, including a from-scratch non-admin responder (seeded
  with only `householdIds`, matching the population profile of anyone who joined after the
  multi-household migration) successfully joining and leaving a branch via `updateBranchMembership`
  — the specific case the old rule silently could never have supported — and a live address-book
  import creating both a new household and a linked no-account contact in one paste.
- **Production migration required, not yet run as of this writing**: existing real family data
  (e.g. "Amanda Knaub," "Bill Martin," entered via an earlier address-book import) still lives in
  the old `households/{id}.extraContacts` array in production Firestore. Deploying this code without
  first running that migration would make those real no-account family members silently disappear
  from Contacts/Family Tree/the household editors (the new code only reads `contacts`, no dual-read
  fallback was built for this one, unlike `userHouseholdIds()`'s tolerant read for the singular→array
  migration). `firestore:rules` and `functions` are safe to deploy independently at any time; hold
  `hosting` until the migration has run, or run both in the same sitting.

## Family Tree

Contacts tab → "🌳 View Family Tree" (`#openTreeBtn`/`#treeModalBg`). A pure client-side
render of already-live-synced data (`branches`/`households`/`householdsById`/`usersById`/
`allApprovedUsers`/`familyContacts`) — no new Firestore reads, writes, or rules. Three sections,
in order: branches with their households (and each household's members + no-account contacts
filtered from `familyContacts` by `householdIds`, tagged "no account") nested inside via a
classic nested-`<ul>`/connector-line CSS treatment
(`renderFamilyTree()`/`householdNodeHtml()`/`personNodeHtml()`/`extraContactNodeHtml()`); any
household not in a branch, under "— Not in any group —"; any approved member with no
household, under "— No household —".

**Scoped deliberately as a Branch → Household → Person grouping view, not a genealogical
chart** — there's no parent/child/spouse/sibling relationship data anywhere in the data
model to draw actual lineage lines from. If a real family tree (who's whose parent, married
to whom, etc.) is wanted later, that needs new fields on User/extraContacts and is a
materially bigger feature, not an extension of this one.

Verified against the emulator: a branch containing one household (with 2 real members + 1
`extraContacts` no-account entry) rendered nested correctly with the right counts; a second,
unrelated household correctly fell into "Not in any group"; a third seeded user with no
`householdId` correctly fell into "No household"; open/close both worked; no console errors.

## Profile pages

Tap any person's avatar or name anywhere in the app — Contacts, chat messages, a Wall post's
author, a comment's author — and their profile opens (`#profileModalBg`): a header (avatar,
name, age badge, admin badge, household, and any branch(es) their household belongs to),
Edit Info / Message action buttons (same visibility rules as elsewhere — `canEditProfile()`
for the edit button, hidden for your own Message button), and a feed of just their own Wall
posts, rendered via the existing plain `buildDefaultWallCard()` regardless of the viewer's
active theme.

Wiring uses one delegated `document` click listener for any element tagged
`class="profileLink" data-uid="{uid}"`, rather than a per-render-site handler — added to
Contacts rows, chat message sender lines, comment author lines, and the author name/avatar
in all 9 Wall theme layouts (`renderWallFeed()`) plus `buildDefaultWallCard()`. When a new
Wall layout or another "person shows up" surface is added later, tag its author/name element
the same way and the click just works — no extra wiring needed.

The profile's own post feed queries `where('authorId','==',uid)` with **no** `orderBy` —
combining an equality filter with `orderBy` on a different field needs a composite Firestore
index; sorting the (typically small, single-person) result client-side avoids that, same
avoided-composite-index approach used by `fetchOrdersFromFirestore`-style code elsewhere in
this project's sibling repo. The feed listener (`onSnapshot`) is subscribed only while the
modal is open and explicitly unsubscribed on close, so it doesn't linger as a background
listener for every profile ever viewed in a session.

Verified against the emulator: opened from Contacts, from a classic-theme Wall post, and
from a Facebook Blue-theme Wall post — header/household/branch/posts all rendered correctly
in each case, close button unsubscribed and closed correctly, no new console errors beyond a
pre-existing transient reload race already documented above (unrelated to this feature — its
listener doesn't start until the modal is actually opened).

## Notifications

A 🔔 bell in the header (unread-count badge) opens a list of who reacted to or commented on
your Wall posts (including thread activity — someone commenting on a post you'd already
commented on, not just the post's original author) or sent you a DM — see "Message
notifications" below for that last one, added later than the other two.

- **Reaction notifications** use a deterministic doc id (`reaction_{postId}_{fromUserId}`, see
  `notifDocId()`) instead of an auto-generated one: switching your reaction overwrites the same
  notification (`notifyReaction()`, called from `setReaction()`) rather than piling up duplicates,
  and removing your reaction entirely deletes it outright (`clearReactionNotif()`) instead of
  leaving a stale "reacted" entry behind.
- **Comment notifications** use a normal auto-generated id — every comment is a distinct event,
  unlike a reaction which only has one current state per person. `notifyComment()` notifies the
  post's author plus everyone who's already commented on the thread (queried fresh at comment
  time), excluding the commenter themself and de-duplicated via a `Set`.
- Both helpers skip creating a notification entirely when the recipient would be the actor
  themselves (no self-notify for reacting to or commenting on your own post).
- `initNotifications()` subscribes to `where('forUserId','==', currentUser.uid)` — a single
  equality filter, no `orderBy`, sorted client-side for the same avoided-composite-index reason
  documented elsewhere in this file — alongside the app's other `init*()` calls once the shell
  is ready, and unsubscribes in `cleanupListeners()` like every other listener.
- `firestore.rules`' `notifications` match block is deliberately asymmetric: the **actor**
  (`fromUserId`) can create a notification for someone else (never themselves — `forUserId !=
  request.auth.uid` is enforced server-side too) and can later delete it (needed for reaction
  removal); the **recipient** (`forUserId`) can read, mark-as-read, or delete it, but can never
  create one addressed to themselves. Verified against the emulator: Bob reacting/commenting on
  Alice's post correctly produced her notifications and live-updated her unread badge; Bob
  un-reacting correctly deleted the reaction notification while the separate comment notification
  stayed; clicking a notification correctly flipped it to read and dropped the badge count; and
  two adversarial writes — impersonating a different `fromUserId`, and a self-addressed
  `forUserId == fromUserId` notification — were both correctly denied.

### Message notifications (added 2026-08-22 — DMs were previously completely silent)

Ryan reported receiving a DM with zero notification, in-app or push, despite push being enabled.
Root cause: the entire notification system above (bell + push) was built exclusively for Wall
reactions/comments — `sendMessage()` never wrote a `notifications/{id}` doc at all, so a DM (or
any chat message) has never triggered anything, ever. Not a bug in the push pipeline itself
(proven working by the reaction/comment path) — a missing feature.

- **Scoped to DMs only, not group channels** (Whole Family/household/branch chat) — a deliberate
  choice, not an oversight: notifying every recipient on every message in a busy group channel
  risks being genuinely noisy, whereas a DM going unnoticed defeats the point of it being private.
  If group-channel message notifications are wanted later, `notifyDmMessage()` is the pattern to
  extend (see its `if (activeChannelId.startsWith('dm_'))` guard in `sendMessage()`) — the
  recipient list would just be `channels/{id}.participantIds` filtered to exclude the sender
  instead of a single `find()`.
- `notifyDmMessage(channelId, text)`: looks up the channel doc's `participantIds` directly
  (`getDoc`, not the `dmChannels` cache) specifically so it's correct even for the very first
  message in a brand-new DM, before the recipient-side listener would have had time to deliver
  the channel back into any cache. Writes a `type: 'message'` notification with `channelId` (not
  `postId` — there's no post involved) and a `textPreview`.
- `notifRowHtml()` and `sendPushOnNotification`'s title/body/tag logic both extended with a third
  branch for `type === 'message'` (previously only reaction/else-assumed-comment).
- **Clicking a message notification now navigates straight to that DM conversation**, not just
  marking it read — a genuinely more useful action for a message than for a reaction/comment,
  where the destination (the Wall, one tab away) is already obvious. Extracted the tab-switch/
  channel-open logic that `startDM()` already had into a shared `openChannel(channelId)` so both
  call sites (starting a fresh DM from a profile, and opening one from a notification) share one
  implementation instead of duplicating it.
- **Known simplification, not fixed**: a message always notifies the recipient, even if they're
  currently looking at that exact conversation. The sender has no visibility into the recipient's
  UI state to suppress it, and over-notifying is a much smaller problem than the bug being fixed
  (under-notifying, i.e. never at all) — not worth the complexity for this pass.
- Verified against the emulator end-to-end: Bob DMing Alice correctly created a `notifications`
  doc, correctly triggered `sendPushOnNotification` (confirmed via emulator logs — it completed
  without error; the actual push send itself short-circuits harmlessly when the recipient has no
  `pushSubscriptions`, same as any other notification type), Alice's bell badge updated live to
  "1" with the right preview text, and clicking the notification correctly opened the exact DM
  conversation with Bob's message visible.

### Push notifications (real browser/OS notifications when the app is closed)

**Live** — VAPID key pair generated and wired in, secret set, `sendPushOnNotification` deployed
2026-08-20. The in-app bell only fires while the tab is open; this extends the same
`notifications/{id}` docs to a real system notification via the standard Web Push API — plain
Web Push, deliberately **not** Firebase Cloud Messaging, so setup never required a trip to the
Firebase Console (see rationale below).

- `app/push-sw.js`: a minimal service worker (`push`/`notificationclick` handlers only — no
  Firebase SDK in it at all). Registered on-demand from `enablePush()` in app/index.html, not
  eagerly on every page load, since there's nothing for it to do until someone opts in.
- Client (`app/index.html`, "Push notifications" section): `enablePush()`/`disablePush()` wired
  to a toggle row (`renderPushRow()`) inside the 🔔 Notifications modal. Enabling requests
  browser permission, subscribes via `pushManager.subscribe()`, and stores the resulting
  `{endpoint, keys}` object in `users/{uid}.pushSubscriptions[]` (one entry per device/browser —
  a member can have push on for their phone and their laptop independently). No new Firestore
  rule was needed: `pushSubscriptions` is just another field on the user's own doc, already
  covered by the existing generic self-update rule on `users/{userId}`.
- Server (`functions/index.js`, `sendPushOnNotification`): a Firestore trigger on the *same*
  `notifications/{id}` docs the in-app bell reads — push is additive, not a separate code path,
  so it can never say something different than what's already in the bell. Sends via the
  `web-push` npm package to every subscription on file for the recipient; a subscription that
  comes back 404/410 (permanently dead — uninstalled, permission revoked at the OS level) is
  pruned from the array so future sends don't keep retrying it.
- **Why plain Web Push instead of Firebase Cloud Messaging**: FCM's Web Push setup requires a
  one-time manual step in the Firebase Console (Project Settings → Cloud Messaging → Web Push
  certificates → generate a key pair) that only produces a *paired* public+private key through
  that UI — there's no way to script it. Plain Web Push uses the exact same VAPID key-pair
  mechanism under the hood, but the pair can be generated with a one-line CLI command
  (`npx web-push generate-vapid-keys`) instead, keeping this fully self-contained and
  console-free, consistent with how the rest of this project avoids manual console steps
  wherever a CLI equivalent exists.
- **The private key was deliberately never generated by Claude** — unlike the Gmail App
  Password or other secrets in this project (which the user always sets directly via
  `firebase functions:secrets:set`, never pasted into chat), a fresh VAPID key pair is trivial
  to generate, so the cleanest boundary is to have the *user* run the generator themselves too,
  so the private half never enters the session transcript at all. The public half is safe to
  share and gets hardcoded in both `app/index.html` (`VAPID_PUBLIC_KEY`) and
  `functions/index.js` (`VAPID_PUBLIC_KEY`) — it's meant to be embedded in client code by
  design, same as Firebase's own `apiKey`.
- **How the one-time setup actually went** (kept here as a record, since the same shape of
  step — a fresh, easily-regenerable credential where the CLEAN split is "user generates it,
  Claude never sees the private half" — will come up again): the user ran
  `npx web-push generate-vapid-keys` themselves, pasted back only the public key in chat (safe —
  it's meant to be embedded in client code), which got hardcoded into both
  `VAPID_PUBLIC_KEY` constants (`app/index.html` and `functions/index.js`); the user separately
  ran `firebase functions:secrets:set VAPID_PRIVATE_KEY --project house-of-martin` themselves,
  entering the private key at the hidden CLI prompt — it never appeared in this session at all.
  Deploying `functions:sendPushOnNotification` before the secret existed failed immediately and
  clearly (`Cloud Secret Manager has no latest version of the secret defined by param
  VAPID_PRIVATE_KEY`) rather than silently, confirming the placeholder-based degrade worked as
  designed right up until the real deploy.
- Client-side UI degrades in three tiers, checked in this order in `renderPushRow()`: not
  configured (`VAPID_PUBLIC_KEY` still the literal placeholder string) → the whole row stays
  empty, no confusing message; configured but the browser doesn't support Web Push → a plain
  explanatory line, no button; configured and supported → the actual enable/disable toggle. Now
  that the real key is wired in, every approved member sees the actual toggle on a supported
  browser.
- Verified so far: the full placeholder-state degrade (Notifications modal opens cleanly, push
  row correctly empty, no console errors) against the emulator; `push-sw.js` confirmed served as
  the real static file in production via direct `curl` (not swallowed by the hosting config's
  SPA catch-all rewrite — Firebase Hosting serves an exact static-file match before applying
  rewrites); the `sendPushOnNotification` deploy itself succeeding cleanly once the secret
  existed. **Not yet verified**: an actual subscribe → notify → receive round trip on a real
  device — Claude has no real production login and deliberately never held the private key, so
  this specific check needs a real member (e.g. the user) to tap "Enable push notifications,"
  grant the browser permission prompt, and confirm a real reaction/comment from someone else
  produces an actual OS-level notification.

## Account deactivation

Admin-only, from Contacts → 🚫 next to anyone but yourself (self-deactivation is hidden in the
UI, same "have a different admin do it" precedent as self-demoting your own admin role).
Reactivate from Admin → 🚫 Deactivated accounts.

- **A third `users/{uid}.status` value, `'deactivated'`**, alongside `'pending'`/`'approved'`.
  **No `firestore.rules` change was needed at all** — `isApprovedMember()`/`isAdmin()` already
  require `status == 'approved'`, so flipping status to anything else instantly cuts the account
  out of every single rule that gates on those two helpers (posts, channels, households, wall,
  reactions, notifications, all of it) — deactivating an admin revokes their admin powers too,
  immediately, not just their member-level access. The existing `users/{userId}` update rule
  already restricted `status`/`role` changes to admins only, so only an admin can deactivate or
  reactivate anyone in the first place.
- **History is never touched.** Deactivating doesn't delete or hide the account's past posts,
  comments, messages, or household membership — matches this project's general "don't destroy
  data" posture (see e.g. the mode-reset behavior in the sibling `auggies-deploy` project for the
  same philosophy elsewhere). An admin can separately edit the household/reassign responder if
  that's actually wanted.
- **A deactivated account can always read its own `users/{uid}` doc** (the `request.auth.uid ==
  userId` clause in the read rule doesn't check status), which is what makes the block instant
  and live rather than something that only takes effect on next login: the app's `onAuthStateChanged`
  handler keeps a permanent `onSnapshot` on the signed-in user's own doc (same listener that made
  auto-approval "instant" — see that section above), so an admin deactivating someone mid-session
  flips them straight to a blocked screen in real time, no refresh needed, and correctly tears
  down every other listener (`cleanupListeners()`) at that moment too — otherwise they'd keep
  running against data the rules no longer allow, throwing a stream of permission-denied errors
  instead of cleanly stopping.
- The blocked screen (`#pendingScreen`) now shows one of two messages depending on `status` —
  the original "You're on the list 🎉 ... check back soon" for `'pending'`, or "Account
  deactivated ... reach out to [an admin] directly" for `'deactivated'` — so a deactivated member
  isn't confusingly told to "check back soon" as if they were a brand-new unapproved signup.
- Verified against the emulator: a fresh sign-in as an already-deactivated account correctly shows
  the deactivated screen; deactivating someone with their session already open correctly flips
  them live with no reload and only one harmless race-condition console error (not the
  continuous-error spam it'd be without the `cleanupListeners()` call); the Admin →
  Deactivated-accounts list correctly showed the account with its deactivation date, and
  Reactivate correctly restored `status: 'approved'` live; three adversarial writes — a non-admin
  deactivating someone else, a non-admin reactivating someone else, and a non-admin
  self-deactivating — were all correctly denied by the pre-existing rule (no rule changes were
  made, so this also served as regression coverage for it).

## Active-conversation clarity

Ryan's dad got confused about which conversation he was in — Whole Family vs. a DM — because the
channel switcher (`#channelList`) was a horizontally-scrolling row of same-looking pills, the only
difference being a small emoji prefix and an accent-color fill on whichever one happened to be
active. Easy to miss, especially once the row has enough pills to scroll.

- **A sticky `#activeConvoHeader` above the message list** now always names the open conversation
  in large text, plus a one-line plain-English subtitle of who can see it — "👪 Whole Family —
  Everyone in the family can see this," "🏠 The Martins — Household chat — just your household,"
  "🌳 [Branch] — Branch chat — every household in this group," or "🔒 [Name] — Private — only the
  two of you can see this." `activeConvoInfo()` is the single source of truth this header and the
  pill row both read from, so they can never disagree about what "active" means.
- **DM pills are now visually distinct from group pills even when inactive** — a permanent
  `--accent-soft` tint (`.dmPill`) plus a small avatar circle (`avatarHtml()`) instead of just a
  💬 emoji, with a thin vertical divider (`#channelDivider`) separating the group channels (Whole
  Family/household/branch) from the private ones in the scrollable row. The intent: a private 1:1
  chat should look categorically different from a group chat, not just differently labeled.
  "Whole Family" also got an explicit 👪 icon (it had none before) so all four conversation types
  now carry a consistent icon+color language.
- The active pill now auto-scrolls into view (`scrollIntoView`) whenever the conversation changes,
  so switching via `startDM()` (e.g. tapping 💬 in Contacts or a profile page) doesn't leave the
  now-active pill scrolled off-screen with no visible indication anything changed.
- Verified against the emulator: all four conversation types (Whole Family, household, branch, DM)
  produce the correct icon/title/subtitle in the header; the DM pill correctly carries `.dmPill`
  and shows the other person's real avatar; the divider renders between group and DM pills.

## PWA install (manifest + icons)

Previously "Add to Home Screen" just bookmarked the page — there was no `manifest.json` at all,
so Android/Chrome had no name/icon/display-mode to install with (iOS Safari has always been able
to fake a home-screen icon off just the page `<title>` and an `apple-touch-icon`, but that's a
much shallower experience than a real installable PWA).

- `app/manifest.json`: name, `display: "standalone"`, `theme_color`/`background_color` matching
  the Classic theme's palette (`#a9432f` accent, `#f6f1ea` background), and three icons.
- `app/icon-192.png`, `app/icon-512.png`, `app/icon-maskable-512.png`: a flat accent-color house
  silhouette (roof triangle + body rectangle + door cutout), generated by a **pure-Node PNG
  encoder with zero dependencies** (raw RGBA pixel buffer → `zlib.deflateSync` → hand-built
  PNG chunk framing) rather than any design tool. This was a direct fix for a real failure mode
  hit while building it: the first two attempts tried to hand-transcribe a large base64 PNG
  data-URL (generated via an actual `<canvas>` in the browser) into a file, and **silently
  corrupted the string both times** — large base64 blobs are exactly the kind of data an LLM
  should never retype from its own context into a tool call, since there's no mechanism forcing
  exact reproduction and a corrupted middle silently produces a broken (or worse, subtly wrong)
  image with no error at write time. The fix wasn't "be more careful transcribing" — it was
  restructuring the task so the data never had to pass through a retyping step at all: a script
  that *computes* the bytes programmatically and writes them directly, verified after the fact
  by checking the actual PNG signature/IHDR dimensions and visually reading the rendered file
  back. The maskable variant keeps the house glyph inside the inner ~60% "safe zone" per the
  maskable-icon spec, with the accent color filling the full canvas so Android's adaptive-icon
  cropping never reveals a hard edge.
- `<link rel="manifest">` and `<link rel="apple-touch-icon">` added to `app/index.html`'s
  `<head>`, and `push-sw.js` (already built for Web Push, see above) is now **registered
  unconditionally on every page load**, not just lazily inside `enablePush()` — registering a
  service worker never itself prompts for anything (only `Notification.requestPermission()` and
  `pushManager.subscribe()` do, and those still stay behind the explicit "Enable push
  notifications" button), but Chrome/Android's installability criteria require an active service
  worker at the manifest's scope before it'll offer the enhanced "Install app" flow — so this one
  small change is what makes both features (push and real installability) work correctly
  together instead of the eager one blocking the lazy one.
- No `firebase.json` rewrite changes needed — same reasoning already established for
  `push-sw.js`: Firebase Hosting serves an exact static-file match before applying the `**` → 
  `/index.html` SPA catch-all rewrite, so `manifest.json` and the icon files serve correctly
  just by existing in `app/`.
- Verified in production (not just the emulator, since this is pure static hosting with no
  Firestore/Auth involved): `https://house-of-martin.web.app/manifest.json` returns the real
  JSON (not swallowed by the rewrite), `/icon-512.png` loads as an actual 512×512 image, and the
  main page loads with zero console errors after adding the eager service worker registration.

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
handoff/extraContacts/branch membership), self-service household join/leave/create
for any member from the Edit Info modal (see "Households & Branches — how it
actually works" below — moving a no-account extraContact to a *different*
household stays admin-only, since that touches a household the acting member
doesn't belong to), DM channels (genuinely private, not just UI-hidden — see the Firestore
rules gotcha above), weekly digest email (Cloud Functions — see section above),
multi-admin role management, admin Dashboard (live counts + estimated costs),
11-preset theme system with personal/family-default resolution, admin custom
theme editor, header banner photo filmstrip, potluck-style event sign-up
lists, auto-approval on a known email match (verified live in production),
profile pictures (`avatarHtml()` — real photo or a deterministic colored
initials circle, used everywhere a person shows up: Contacts, chat, Wall),
functional Wall Reactions/Comment/Share across all 9 theme Wall layouts, with six
Facebook-style reaction types (see "Theme System" section above and Data Model below),
a Family Tree view
(Branch → Household → Person grouping — see "Family Tree" section above),
tap-to-open profile pages from anywhere a person shows up (see "Profile
pages" section above), and a notifications bell for reactions/comments on your
posts (see "Notifications" section above), with real browser/OS push notifications
now live (see "Push notifications" above), and account deactivation for a real
account holder's login (see "Account deactivation" section above), which was
the last item on this list.

**Deferred (declined, not just unfinished):** native app wrapper — App Store/Play Store overhead
(developer fee, review process, two extra build pipelines) isn't worth it for a private family
app this size; the PWA install (real manifest + icon, see "PWA install" above) covers the same
"icon on the home screen" need for free.

**Open items (as of 2026-08-22):**
- **Push notifications — real-device round trip not yet confirmed.** Deployed, and every piece
  up to the actual OS notification has been verified (see "Push notifications" above), but Claude
  has no real production login and deliberately never held the private VAPID key, so the last
  step — a real member taps "Enable push notifications," grants the browser permission prompt,
  and confirms a real reaction/comment from someone else produces an actual OS-level notification
  — needs a real person (Ryan or a family tester) to do it.
- **Active-conversation clarity fix — awaiting Dad's confirmation.** Built and deployed in
  response to Dad getting confused about Whole Family vs. a DM (see "Active-conversation clarity"
  above); not yet confirmed whether it actually solved the confusion for him specifically.
- **Household setup worksheet bulk-import — offered, not started.** Claude offered to build a
  bulk-import tool for the worksheet answers (see the household/branch guide artifact and
  "Households & Branches" section above) once Ryan starts collecting them from the family; no
  decision made yet on whether/when to build it.
- **Possible rename to "MyFamily" — floated, not decided.** Ryan mentioned this as a *potential*
  future direction if this app is ever reused beyond the Martin family specifically. Only the app
  icon has been changed so far (to a name-agnostic house + family-of-three glyph, see "PWA
  install" above) — the manifest's `name`/`short_name`, the page `<title>`, and every in-app
  reference to "House of Martin" are all still exactly as-is until an explicit decision is made.
- **General polish pass — app feels clunky, both aesthetically and functionally.** Ryan's own
  assessment, not a specific bug report. Addressed so far — see "Contacts layout", "Households &
  Branches — how it actually works" / "Multi-household membership", "General polish pass
  (2026-08-22)", and "Admin tab audit (2026-08-22, same day, follow-up pass)" above (the
  "drop-down to add someone from the app" request turned out to be about the household editor
  specifically, and led to the bigger multi-household-membership change once Ryan confirmed
  that's what he actually wanted; the two 2026-08-22 passes were real structural/DOM audits of
  every tab, not guesses, and fixed: the composer-cards-pinned-above-content pattern recurring in
  Events and Wall, duplicate reaction-button hearts, event-card visual hierarchy, and — the
  biggest single fix of this whole pass — the Admin tab's 11 always-expanded cards collapsed into
  an accordion, cutting its scrolled height by well over half). Still open: no further concrete
  areas identified yet — every tab has now had at least one audit pass. Next step, if wanted, is
  either a second, deeper pass on a specific tab or waiting for Ryan to flag something specific.
  The Wall audience picker and Event invite picker remain plain `<select>`s — never the actual
  complaint, so intentionally untouched.
- **Story Prompts voice recording — real-device round trip not yet confirmed.** Deployed
  2026-08-29 (see below); the MediaRecorder + microphone path couldn't be exercised by browser
  automation (no real mic in that environment), so only the typed-text answer path and the
  archive were actually proven working. Needs a real person to tap "🎤 Record a voice answer" on
  an actual phone/browser, grant the mic permission prompt, and confirm the recording uploads and
  plays back correctly — same shape of gap as the push-notification real-device item above.

**2026-08-29/30 session — chaos testing + three "make the app worth opening unprompted"
features:** Ran three rounds of adversarial (chaos) testing directly against `firestore.rules`
using the real client SDK (not admin, which bypasses rules) — 45 attack scenarios across every
collection (RSVPs, households, branches, users, DMs, notifications, contacts, Wall, comments,
albums, digest submissions, occasions, config, invite codes). Found and fixed one real hole:
`events/{id}/rsvps/{rsvpId}` only checked that `submittedBy == caller`, never that `rsvpId`
actually belonged to a household the caller responds for — any approved member could silently
overwrite anyone else's individual RSVP on any event. Fixed with a `get()`-verified responder
check; all 45 scenarios pass now. Also found and fixed five instances of the same "listener race"
bug class (a render function reads global state populated by a *different* Firestore listener
than the one that re-renders it, so whichever listener wins the race first can leave the other
permanently stale): missing household-RSVP option and missing attendee names on Events, stale
Wall/Event audience descriptions, the Admin → Branches household checklist, DM sender avatars,
and the notification bell's actor avatars — all fixed by cross-wiring the relevant listeners to
re-render each other, verified against the emulator, not just code-reviewed. Then built three
features aimed at making the app something people open without being asked: **On This Day**
(Facebook-Memories-style card on the Wall surfacing posts from the same month/day in past years),
the **Birthday Spotlight** (a scheduled Cloud Function that auto-posts a Wall callout the morning
of any birthday/anniversary in the Calendar, skipping deceased/memorial entries), and **Story
Prompts** (a new "📖 Stories" tab with a weekly rotating family-history question, answerable by
text or a recorded voice clip, archived permanently — see the open item above for what's still
unverified there). Also set up a GitHub remote (`github.com/oldfortytwo-dev/House-of-Martin`,
private) for this repo, which hadn't had one before.

## Working Style / Preferences

(Carried over from the developer's other project — apply here too.)

- Prefer diagnosing root cause over patching symptoms
- Surgical, precise edits — verify exact anchor text before replacing
- Syntax-check JS after edits (`node --check` on extracted script blocks, or equivalent)
- No build step, no framework — plain HTML/JS matching the `auggies-deploy` repo's style
