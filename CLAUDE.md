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
  deactivation" below), householdId, inviteCodeUsed, deactivatedAt (null unless status is
  'deactivated'), pushSubscriptions[] ({endpoint, keys:{p256dh,auth}} — one per device/browser
  with push notifications enabled, see "Push notifications" below)
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

## Households & Branches — how it actually works

Came up because the model wasn't obvious from using the app — worth re-reading before touching
this area again, and worth re-explaining to the user if it comes up.

- A **household** is a family unit sharing an address (e.g. "The Alvarez-Martins"). It has
  members (real accounts), an optional list of no-account family members (`extraContacts`, e.g.
  young kids), a responder, and shared contact info.
- A **branch** is a group of *households* (e.g. "Descendants of Grandpa Joe"), not a group of
  people. You don't join a branch directly — your household does, and you're in it by extension.
  This is the part that's confusing on first read: there's no "add yourself to a branch" concept
  at the person level by design, only "which branch(es) does my household belong to."
- **Everyone can join/leave/create a household themselves**, from the Edit Info modal (their own,
  or — if admin — anyone's): a Household dropdown lists every household plus "+ Create a new
  household…". Selecting a different one leaves the old and joins the new in one write; creating
  one as a non-admin makes you its first member and responder automatically (an admin creating one
  starts it empty, since there's no "self" to default into it).
- **Only a household's responder can pick which branch(es) it belongs to** — from Contacts →
  "Edit My Household" → the branch checklist. This is deliberately at the household level, not
  the person level, matching the model above.
- **Regular members can't create/manage branches themselves** — only assign their own household
  to existing ones. Creating a new branch is still Admin → Branches (an admin-only concept, since
  a branch groups multiple households together and needs someone with a bird's-eye view).
- Both of these are genuine self-toggle permissions in `firestore.rules`, not just hidden UI —
  see the Firestore rules for the exact mechanism (Set-difference check ensuring you can only
  add/remove *yourself* or *your own household*, never anyone else's membership).

## Family Tree

Contacts tab → "🌳 View Family Tree" (`#openTreeBtn`/`#treeModalBg`). A pure client-side
render of already-live-synced data (`branches`/`households`/`householdsById`/`usersById`/
`allApprovedUsers`) — no new Firestore reads, writes, or rules. Three sections, in order:
branches with their households (and each household's members + `extraContacts`, tagged "no
account") nested inside via a classic nested-`<ul>`/connector-line CSS treatment
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
your Wall posts — including thread activity (someone commenting on a post you'd already
commented on, not just the post's original author).

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

## Working Style / Preferences

(Carried over from the developer's other project — apply here too.)

- Prefer diagnosing root cause over patching symptoms
- Surgical, precise edits — verify exact anchor text before replacing
- Syntax-check JS after edits (`node --check` on extracted script blocks, or equivalent)
- No build step, no framework — plain HTML/JS matching the `auggies-deploy` repo's style
