const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const nodemailer = require('nodemailer');
const webpush = require('web-push');
const Anthropic = require('@anthropic-ai/sdk');

initializeApp();
const db = getFirestore();

const GMAIL_USER = defineSecret('GMAIL_USER');
const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');
// For the Recipe Box's "analyze photo with AI" button (extractRecipeFromPhoto below). Set with
// `firebase functions:secrets:set ANTHROPIC_API_KEY` using a real key from console.anthropic.com
// — this is a real paid API, unlike every other integration in this app (Nominatim/Leaflet for
// the event map, Gmail SMTP for the digest) which are free. Each photo analyzed costs a small,
// real amount — negligible at family-app volume, but worth knowing it's not free like the rest.
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

// Public half of the Web Push VAPID key pair — safe to hardcode, it's meant to be embedded in
// client code (matches the same constant in app/index.html). Only the private half is secret.
const VAPID_PUBLIC_KEY = 'BGGJ7biojqi7m0Cm-sVx-jRU1X3yhISPM3hW6UnBHQBQW-cePg9VthSlFxdo9BGprJZ4cYFXYoTrnFQRImlif_I';
const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function daysUntil(month, day, from) {
  const now = new Date(from);
  now.setHours(0, 0, 0, 0);
  let next = new Date(now.getFullYear(), month - 1, day);
  if (next < now) next = new Date(now.getFullYear() + 1, month - 1, day);
  return Math.round((next - now) / 86400000);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function buildDigestContent() {
  const now = new Date();

  // Upcoming birthdays / anniversaries (next 7 days)
  const occSnap = await db.collection('occasions').get();
  const occasions = [];
  occSnap.forEach(d => {
    const o = d.data();
    if (!['birthday', 'anniversary'].includes(o.type) || !o.month || !o.day) return;
    const days = daysUntil(o.month, o.day, now);
    if (days <= 7) occasions.push({ ...o, days });
  });
  occasions.sort((a, b) => a.days - b.days);

  // Upcoming events (next 7 days)
  const evSnap = await db.collection('events').get();
  const events = [];
  evSnap.forEach(d => {
    const e = d.data();
    if (!e.when) return;
    const when = new Date(e.when);
    const days = Math.round((when.setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
    if (days >= 0 && days <= 7) events.push({ ...e, when: new Date(e.when), days });
  });
  events.sort((a, b) => a.when - b.when);

  // Open member submissions not yet sent in a digest
  const subSnap = await db.collection('digestSubmissions').where('includedInDigestAt', '==', null).get();
  const submissions = [];
  subSnap.forEach(d => submissions.push({ id: d.id, ...d.data() }));
  submissions.sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));

  const occLines = occasions.map(o => {
    const icon = o.type === 'anniversary' ? '💍' : '🎂';
    const when = o.days === 0 ? 'today' : o.days === 1 ? 'tomorrow' : `in ${o.days} days (${MONTH_NAMES[o.month - 1]} ${o.day})`;
    return { icon, text: `${o.name} — ${when}` };
  });
  const evLines = events.map(e => {
    const when = e.when.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    return { icon: '📅', text: `${e.title} — ${when}${e.where ? ' at ' + e.where : ''}` };
  });
  const subLines = submissions.map(s => ({ icon: '📣', text: `${s.text} — ${escapeHtml(s.submittedByName || 'A family member')}` }));

  const section = (title, lines) => {
    if (!lines.length) return '';
    return `<h2 style="font-size:16px;color:#a9432f;margin:24px 0 8px">${title}</h2>` +
      lines.map(l => `<div style="padding:6px 0;border-bottom:1px solid #e7ddd2">${l.icon} ${escapeHtml(l.text)}</div>`).join('');
  };

  const bodyHtml = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#2a2220">
      <h1 style="font-size:22px;margin-bottom:4px">House of Martin — This Week</h1>
      <p style="color:#6b5f58;margin-top:0">Your weekly family digest.</p>
      ${section('🎂 Birthdays &amp; Anniversaries', occLines)}
      ${section('📅 Upcoming Events', evLines)}
      ${section('📣 From the Family', subLines)}
      ${!occLines.length && !evLines.length && !subLines.length ? '<p style="color:#6b5f58">Nothing new this week — quiet week for the family!</p>' : ''}
      <p style="color:#6b5f58;font-size:12px;margin-top:32px">Sent from House of Martin. Add your own item for next week\'s email from the Events tab.</p>
    </div>`;

  const bodyText = [
    'House of Martin — This Week',
    '',
    occLines.length ? 'Birthdays & Anniversaries:\n' + occLines.map(l => '- ' + l.text).join('\n') : '',
    evLines.length ? 'Upcoming Events:\n' + evLines.map(l => '- ' + l.text).join('\n') : '',
    subLines.length ? 'From the Family:\n' + subLines.map(l => '- ' + l.text).join('\n') : '',
  ].filter(Boolean).join('\n\n');

  return { html: bodyHtml, text: bodyText, submissionIds: submissions.map(s => s.id) };
}

async function sendDigest(gmailUser, gmailAppPassword, testEmails) {
  const isTest = Array.isArray(testEmails) && testEmails.length > 0;
  let emails;
  if (isTest) {
    emails = testEmails;
  } else {
    const usersSnap = await db.collection('users').where('status', '==', 'approved').get();
    emails = [];
    usersSnap.forEach(d => { const u = d.data(); if (u.email) emails.push(u.email); });
  }
  if (!emails.length) return { sent: 0, submissions: 0, test: isTest };

  const { html, text, submissionIds } = await buildDigestContent();

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailAppPassword }
  });

  await transporter.sendMail({
    from: `House of Martin <${gmailUser}>`,
    to: gmailUser,
    bcc: emails,
    subject: (isTest ? '[TEST] ' : '') + 'House of Martin — This Week\'s Family Digest',
    text,
    html
  });

  // Test sends never consume submissions — a test should be repeatable without
  // silently marking real member-submitted items as already-sent.
  if (!isTest && submissionIds.length) {
    const batch = db.batch();
    submissionIds.forEach(id => batch.update(db.collection('digestSubmissions').doc(id), { includedInDigestAt: Timestamp.now() }));
    await batch.commit();
  }

  return { sent: emails.length, submissions: isTest ? 0 : submissionIds.length, test: isTest };
}

exports.weeklyDigest = onSchedule({
  schedule: '0 8 * * 1',
  timeZone: 'America/New_York',
  secrets: [GMAIL_USER, GMAIL_APP_PASSWORD]
}, async () => {
  // Strict opt-in: only sends if config/appearance.digestEnabled is explicitly true.
  // Defaults to paused (missing field, or false) — a family shouldn't get emailed
  // just because nobody got around to flipping a switch yet.
  const cfg = await db.collection('config').doc('appearance').get();
  if (!cfg.exists || cfg.data().digestEnabled !== true) {
    console.log('Weekly digest is paused (digestEnabled is not true) — skipping scheduled send.');
    return;
  }
  await sendDigest(GMAIL_USER.value(), GMAIL_APP_PASSWORD.value());
});

// Auto-posts a Wall callout the morning of a birthday or anniversary, so the family sees it and
// remembers to say something, instead of relying on someone happening to check the Calendar tab.
// Runs server-side (not client-triggered) specifically to avoid every family member who opens the
// app that day creating their own duplicate post — this writes exactly one combined post per day,
// at a deterministic doc id (posts/spotlight_YYYY-MM-DD), so even if the schedule somehow fired
// twice in one day the second run just overwrites the same doc instead of duplicating it.
//
// Deliberately excludes: 'memorial' occasions (death anniversaries) and any birthday occasion
// flagged deceased — a cheerful "🎉 Happy Birthday!" callout would be exactly the wrong tone for
// either. Remembering those is a separate, gentler feature if the family ever wants it; this one
// stays purely celebratory.
async function postBirthdaySpotlight(forDate) {
  const now = forDate || new Date();
  const month = now.getMonth() + 1, day = now.getDate();
  const dateKey = now.toISOString().slice(0, 10);

  const occSnap = await db.collection('occasions').get();
  const todays = [];
  occSnap.forEach(d => {
    const o = d.data();
    if (o.month !== month || o.day !== day) return;
    if (o.type === 'birthday' && !o.deceased) todays.push({ icon: '🎂', text: o.name });
    else if (o.type === 'anniversary') todays.push({ icon: '💍', text: o.name });
  });
  if (!todays.length) { console.log(`Birthday spotlight: nothing to celebrate on ${dateKey}.`); return { posted: false }; }

  const lines = todays.map(t => `${t.icon} ${t.text}`).join('\n');
  const heading = todays.length === 1
    ? (todays[0].icon === '🎂' ? `🎉 Happy Birthday, ${todays[0].text}!` : `🎉 Happy Anniversary, ${todays[0].text}!`)
    : `🎉 Celebrating today:`;
  const text = todays.length === 1 ? heading : `${heading}\n${lines}`;

  await db.collection('posts').doc('spotlight_' + dateKey).set({
    text, authorId: 'system', authorName: '🎉 House of Martin', createdAt: Timestamp.now(),
    audience: 'everyone', invitedHouseholdIds: [], invitedBranchIds: [], invitedUserIds: [], reactions: {},
  });
  console.log(`Birthday spotlight: posted ${todays.length} occasion(s) for ${dateKey}.`);
  return { posted: true, count: todays.length };
}

exports.birthdaySpotlight = onSchedule({ schedule: '0 7 * * *', timeZone: 'America/New_York' }, async () => {
  await postBirthdaySpotlight();
});

// Manual trigger for testing/verification, and a future "post now" admin button — mirrors
// sendDigestNow's shape. Accepts an optional {date: 'YYYY-MM-DD'} so it can be tested against a
// date other than today without waiting for a real occasion to line up.
exports.postBirthdaySpotlightNow = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const callerSnap = await db.collection('users').doc(request.auth.uid).get();
  const caller = callerSnap.data();
  if (!caller || caller.status !== 'approved' || caller.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admins only.');
  }
  const forDate = request.data?.date ? new Date(request.data.date + 'T12:00:00') : undefined;
  try {
    return await postBirthdaySpotlight(forDate);
  } catch (err) {
    console.error('postBirthdaySpotlight failed', err);
    throw new HttpsError('internal', err.message || String(err));
  }
});

exports.sendDigestNow = onCall({ secrets: [GMAIL_USER, GMAIL_APP_PASSWORD] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const callerSnap = await db.collection('users').doc(request.auth.uid).get();
  const caller = callerSnap.data();
  if (!caller || caller.status !== 'approved' || caller.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admins only.');
  }
  const testEmails = Array.isArray(request.data?.testEmails)
    ? request.data.testEmails.map(e => String(e).trim()).filter(Boolean)
    : undefined;
  try {
    return await sendDigest(GMAIL_USER.value(), GMAIL_APP_PASSWORD.value(), testEmails);
  } catch (err) {
    console.error('sendDigest failed', err);
    // Surface the real error to the admin instead of the generic "internal" the
    // client would otherwise see — this callable is only ever admin-triggered,
    // there's no sensitive-detail-leak concern the way there would be for a
    // public-facing endpoint.
    throw new HttpsError('internal', err.message || String(err));
  }
});

// Auto-approve a new signup if their email matches a no-account contact record (i.e. someone
// already known from the imported address book / manually added by an admin). A pending user
// can't read the contacts collection themselves (firestore.rules requires isApprovedMember()),
// so this has to run server-side via the Admin SDK, which bypasses rules entirely — that's also
// what keeps it safe: the match logic isn't exposed to the client, only its outcome (approved or
// still pending).
//
// Security note: this trades a small amount of rigor for a lot of admin convenience. Firebase Auth
// doesn't verify email ownership on signup by default, so someone who already holds a valid invite
// code (the pre-existing gate — this doesn't change that) could type in a *known* relative's email
// address and get auto-approved without actually controlling that mailbox. Consistent with this
// app's existing low-security/high-convenience posture for a private family app (see storage.rules'
// albums/ comment for the same tradeoff elsewhere), but worth knowing if the invite code ever leaks
// beyond trusted family. The mitigation, if wanted later, is requiring Firebase email verification
// before auto-approval — not implemented here since it wasn't asked for.
//
// Updated 2026-08-23 for the contacts collection (see "Multi-household membership for no-account
// contacts" in CLAUDE.md): a matched contact can now belong to more than one household, so the
// newly-approved user is added to ALL of them, not just one — the whole reason this promotion
// happened was that a real account could only ever ride into a single household through this
// same path before.
exports.autoApproveKnownEmail = onDocumentCreated('users/{uid}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const user = snap.data();
  if (!user.email || user.status !== 'pending') return;
  const emailLower = user.email.toLowerCase();

  const contactsSnap = await db.collection('contacts').get();
  const matchedDoc = contactsSnap.docs.find(d => (d.data().email || '').toLowerCase() === emailLower);
  if (!matchedDoc) return; // No match — stays pending for the normal manual approval in Admin tab.

  const matched = matchedDoc.data();
  const householdIds = matched.householdIds || [];
  const batch = db.batch();
  batch.update(snap.ref, {
    status: 'approved',
    householdIds,
    phone: user.phone || matched.phone || '',
    birthdate: user.birthdate || matched.birthdate || null
  });
  for (const hhId of householdIds) {
    const hhRef = db.collection('households').doc(hhId);
    const hhSnap = await hhRef.get();
    if (!hhSnap.exists) continue;
    const hh = hhSnap.data();
    const memberIds = hh.memberIds || [];
    const contactIds = hh.contactIds || [];
    batch.update(hhRef, {
      memberIds: memberIds.includes(event.params.uid) ? memberIds : [...memberIds, event.params.uid],
      contactIds: contactIds.filter(id => id !== matchedDoc.id)
    });
  }
  batch.delete(matchedDoc.ref);
  await batch.commit();
  console.log(`Auto-approved ${user.email} (uid ${event.params.uid}) into ${householdIds.length} household(s), matched contact "${matched.name}"`);
});

// Fires whenever the client writes a notifications/{id} doc (see notifyReaction()/
// notifyComment() in app/index.html) and pushes a real browser/OS notification to every
// device the recipient has enabled push on. Additive to the in-app bell, not a replacement —
// if this fails or nobody's subscribed, the in-app notification still exists and was already
// written by the client before this trigger even runs.
exports.sendPushOnNotification = onDocumentCreated({ document: 'notifications/{id}', secrets: [VAPID_PRIVATE_KEY] }, async (event) => {
  const n = event.data.data();
  const userSnap = await db.collection('users').doc(n.forUserId).get();
  const subs = (userSnap.data() || {}).pushSubscriptions || [];
  if (!subs.length) return;

  webpush.setVapidDetails('mailto:noreply@ramcommonlogic.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.value());

  const title = n.type === 'reaction'
    ? `${n.fromUserName} reacted to your post`
    : n.type === 'message'
    ? `${n.fromUserName} sent you a message`
    : `${n.fromUserName} commented on your post`;
  const body = (n.type === 'comment' || n.type === 'message') ? (n.textPreview || '') : '';
  const tag = n.type === 'message' ? `notif_${n.channelId}` : `notif_${n.postId}`;
  const payload = JSON.stringify({ title, body, url: '/', tag });

  const results = await Promise.allSettled(subs.map(s => webpush.sendNotification(s, payload)));
  // A 404/410 means the browser/OS has permanently invalidated that subscription (uninstalled,
  // permission revoked at the OS level, etc.) — prune it so future sends don't keep retrying a
  // dead endpoint. Any other failure (network blip, etc.) is left alone; it'll just be retried
  // next time.
  const stillValid = subs.filter((s, i) => {
    const r = results[i];
    return !(r.status === 'rejected' && [404, 410].includes(r.reason && r.reason.statusCode));
  });
  if (stillValid.length !== subs.length) {
    await userSnap.ref.update({ pushSubscriptions: stillValid });
  }
});

// Lets a household's responder (not just an admin) add or remove an EXISTING account holder
// from their household — e.g. a divided family where a kid belongs to two households. This
// needs to run server-side because it writes to a THIRD PARTY's own user doc
// (users/{userId}.householdIds), which firestore.rules only lets that person themselves (or an
// admin) write — a responder isn't either of those for someone else's account, so there's no
// client-side rules path that could do this safely. The household side of the same edit
// (households/{householdId}.memberIds) IS already writable by the responder directly, but both
// sides have to change together or the two would drift out of sync, so it's simplest to do the
// whole thing here.
exports.updateHouseholdMembership = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const { householdId, userId, action } = request.data || {};
  if (!householdId || !userId || !['add', 'remove'].includes(action)) {
    throw new HttpsError('invalid-argument', 'householdId, userId, and action ("add" or "remove") are required.');
  }

  const callerSnap = await db.collection('users').doc(request.auth.uid).get();
  const caller = callerSnap.data();
  if (!caller || caller.status !== 'approved') throw new HttpsError('permission-denied', 'Not an approved member.');

  const hhRef = db.collection('households').doc(householdId);
  const hhSnap = await hhRef.get();
  if (!hhSnap.exists) throw new HttpsError('not-found', 'Household not found.');
  const hh = hhSnap.data();
  const isAdmin = caller.role === 'admin';
  const isResponder = hh.responderId === request.auth.uid;
  if (!isAdmin && !isResponder) {
    throw new HttpsError('permission-denied', "Only this household's responder or an admin can manage its members.");
  }

  const targetRef = db.collection('users').doc(userId);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists || targetSnap.data().status !== 'approved') {
    throw new HttpsError('failed-precondition', 'That person is not an approved member.');
  }
  const target = targetSnap.data();
  const memberIds = hh.memberIds || [];
  const targetHouseholdIds = Array.isArray(target.householdIds) ? target.householdIds : (target.householdId ? [target.householdId] : []);

  const batch = db.batch();
  if (action === 'add') {
    if (!memberIds.includes(userId)) batch.update(hhRef, { memberIds: [...memberIds, userId] });
    if (!targetHouseholdIds.includes(householdId)) batch.update(targetRef, { householdIds: [...targetHouseholdIds, householdId] });
  } else {
    if (userId === hh.responderId) {
      throw new HttpsError('failed-precondition', "Reassign this household's responder before removing them as a member.");
    }
    batch.update(hhRef, { memberIds: memberIds.filter(id => id !== userId) });
    batch.update(targetRef, { householdIds: targetHouseholdIds.filter(id => id !== householdId) });
  }
  await batch.commit();
  return { ok: true };
});

// Lets a household's responder (not just an admin) join or leave their household in/out of a
// branch (a family sub-group, e.g. "Grandkids" or "East Coast") — needed server-side because
// Firestore rules has no way to express "the one household id that changed belongs to a
// household I respond for": Set values in the rules language can't be converted back to a List
// or indexed, so a diff-derived id can never be plugged into a get() lookup, and there's no loop
// construct to check it any other way. See firestore.rules' branches/{branchId} comment for the
// rules-side history. Direct writes to a branch doc stay admin-only; this is the only path a
// non-admin responder has to toggle their household's branch membership.
exports.updateBranchMembership = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const { branchId, householdId, action } = request.data || {};
  if (!branchId || !householdId || !['join', 'leave'].includes(action)) {
    throw new HttpsError('invalid-argument', 'branchId, householdId, and action ("join" or "leave") are required.');
  }

  const callerSnap = await db.collection('users').doc(request.auth.uid).get();
  const caller = callerSnap.data();
  if (!caller || caller.status !== 'approved') throw new HttpsError('permission-denied', 'Not an approved member.');

  const hhSnap = await db.collection('households').doc(householdId).get();
  if (!hhSnap.exists) throw new HttpsError('not-found', 'Household not found.');
  const hh = hhSnap.data();
  const isAdmin = caller.role === 'admin';
  const isResponder = hh.responderId === request.auth.uid;
  if (!isAdmin && !isResponder) {
    throw new HttpsError('permission-denied', "Only this household's responder or an admin can change its branch membership.");
  }

  const branchRef = db.collection('branches').doc(branchId);
  const branchSnap = await branchRef.get();
  if (!branchSnap.exists) throw new HttpsError('not-found', 'Branch not found.');
  const householdIds = branchSnap.data().householdIds || [];

  if (action === 'join') {
    if (!householdIds.includes(householdId)) await branchRef.update({ householdIds: [...householdIds, householdId] });
  } else {
    await branchRef.update({ householdIds: householdIds.filter(id => id !== householdId) });
  }
  return { ok: true };
});

// Recipe Box's "✨ Analyze photo with AI" button — takes a photo of a handwritten, printed, or
// screenshotted recipe and asks Claude's vision to transcribe it into the same title/ingredients/
// instructions fields the composer already has, so someone can snap a photo of a recipe card
// instead of retyping it. The photo itself is uploaded and kept as the recipe's photo either way
// (this function only returns extracted text, never touches Storage) — this just pre-fills the
// text fields, which the user can still edit before saving.
exports.extractRecipeFromPhoto = onCall({ secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const callerSnap = await db.collection('users').doc(request.auth.uid).get();
  const caller = callerSnap.data();
  if (!caller || caller.status !== 'approved') throw new HttpsError('permission-denied', 'Not an approved member.');

  const { imageBase64, mediaType } = request.data || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    throw new HttpsError('invalid-argument', 'imageBase64 is required.');
  }
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mediaType)) {
    throw new HttpsError('invalid-argument', 'mediaType must be a supported image type.');
  }
  // request.data goes over the wire as JSON, so a huge base64 string means a huge request —
  // cap well under Cloud Functions' request size limit rather than let an oversized photo
  // through untested.
  if (imageBase64.length > 12 * 1024 * 1024) {
    throw new HttpsError('invalid-argument', 'Photo is too large to analyze — try a smaller photo.');
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  let response;
  try {
    response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          {
            type: 'text',
            text: 'This is a photo of a recipe — handwritten, printed, or a screenshot. Transcribe it '
              + 'into a JSON object with exactly these three keys: "title" (string), "ingredients" '
              + '(string, one ingredient per line), "instructions" (string, one step per line). If the '
              + 'photo genuinely is not a recipe, or a field truly cannot be read, use an empty string '
              + 'for that field rather than guessing. Respond with ONLY the JSON object — no markdown '
              + 'fences, no other text.'
          }
        ]
      }]
    });
  } catch (err) {
    console.error('extractRecipeFromPhoto: Anthropic API call failed', err);
    throw new HttpsError('internal', 'Could not reach the AI service. Please try again.');
  }

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new HttpsError('internal', 'The AI did not return a readable response.');

  let parsed;
  try {
    // Strip a markdown code fence if the model added one despite being asked not to.
    const cleaned = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new HttpsError('internal', "Couldn't understand the AI's response — try a clearer photo.");
  }

  return {
    title: typeof parsed.title === 'string' ? parsed.title : '',
    ingredients: typeof parsed.ingredients === 'string' ? parsed.ingredients : '',
    instructions: typeof parsed.instructions === 'string' ? parsed.instructions : '',
  };
});
