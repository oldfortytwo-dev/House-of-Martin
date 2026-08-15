# House of Martin

A private, invite-only web app for the Martin family — messaging, event planning &
RSVPs, a shared contacts directory, and photo sharing. See [`CLAUDE.md`](CLAUDE.md)
for the full project context.

## First-time setup

1. **Create the Firebase project**
   ```bash
   firebase login
   firebase projects:create house-of-martin
   ```
   (or create it at console.firebase.google.com if that project ID is taken).

2. **Enable services** in the Firebase console: Authentication → Email/Password,
   and Firestore Database (start in production mode — rules are already written).

3. **Get your web app config**: Project settings → Your apps → Add app → Web.
   Copy the `firebaseConfig` object and paste it into the `_fbConfig` constant near
   the top of the `<script type="module">` block in [`app/index.html`](app/index.html),
   replacing the `REPLACE_ME` placeholders.

4. **Update `.firebaserc`** if you used a different project ID than `house-of-martin`.

5. **Deploy**
   ```bash
   firebase deploy --only firestore:rules,hosting
   ```

6. **Create the first admin.** Sign up through the app with any invite code you make
   up (it'll sit in "pending"), then in the Firestore console manually set that
   user's doc: `role: "admin"`, `status: "approved"`. Every admin action after that
   (approving new members, creating invite codes) can be done from the app's Admin
   tab.

## Local development (no production Firestore hit)

Same emulator pattern as the `auggies-deploy` repo — the app auto-detects
`localhost`/`127.0.0.1` and points at the emulator suite instead of production.

```bash
firebase emulators:start
```

Then serve `app/` from `localhost` on any static server, e.g.:

```bash
npx http-server app -p 8123
```

Firestore/Auth calls from `http://localhost:8123` will hit the emulators
(`:8080` Firestore, `:9099` Auth), not production.

## What's built (Phase 1 / MVP shell)

- Email/password auth with invite-code-gated signup and admin approval queue
- Households and branches: admin assigns approved members to a household,
  designates a responder, and groups households into branches
- Messaging: family-wide channel plus each member's household channel and any
  branch channel(s) their household belongs to (DM channels are a straightforward
  extension of the same `channels/{id}/messages` pattern — not yet exposed in the UI)
- Event creation + per-person RSVP (yes/maybe/no) with live counts, plus a
  "respond as a family" action for the household's designated responder
- Contacts directory grouped by household, showing shared household phone/address,
  a responder badge, and an "Age N" badge for members 21 or under (self/admin-editable)
- Photo albums with real upload to Firebase Storage: tap an album to open it, add
  photos, tap a photo to view full-size, delete your own (or, if admin, anyone's)
- Admin tab: approve pending members, generate invite codes, manage households/branches

## Not yet built (see `CLAUDE.md` roadmap)

Household self-service editing of shared contact info (currently admin-only),
DM channels, notification digests, family tree view, item sign-up lists,
native app wrapper.
