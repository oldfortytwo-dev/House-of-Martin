const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const nodemailer = require('nodemailer');
const webpush = require('web-push');

initializeApp();
const db = getFirestore();

const GMAIL_USER = defineSecret('GMAIL_USER');
const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');

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

// Auto-approve a new signup if their email matches a household's extraContacts entry (i.e. someone
// already known from the imported address book / manually added by an admin). A pending user can't
// read the households collection themselves (firestore.rules requires isApprovedMember()), so this
// has to run server-side via the Admin SDK, which bypasses rules entirely — that's also what keeps
// it safe: the match logic isn't exposed to the client, only its outcome (approved or still pending).
//
// Security note: this trades a small amount of rigor for a lot of admin convenience. Firebase Auth
// doesn't verify email ownership on signup by default, so someone who already holds a valid invite
// code (the pre-existing gate — this doesn't change that) could type in a *known* relative's email
// address and get auto-approved without actually controlling that mailbox. Consistent with this
// app's existing low-security/high-convenience posture for a private family app (see storage.rules'
// albums/ comment for the same tradeoff elsewhere), but worth knowing if the invite code ever leaks
// beyond trusted family. The mitigation, if wanted later, is requiring Firebase email verification
// before auto-approval — not implemented here since it wasn't asked for.
exports.autoApproveKnownEmail = onDocumentCreated('users/{uid}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const user = snap.data();
  if (!user.email || user.status !== 'pending') return;
  const emailLower = user.email.toLowerCase();

  const householdsSnap = await db.collection('households').get();
  for (const hhDoc of householdsSnap.docs) {
    const hh = hhDoc.data();
    const extraContacts = hh.extraContacts || [];
    const matchIdx = extraContacts.findIndex(ec => (ec.email || '').toLowerCase() === emailLower);
    if (matchIdx === -1) continue;

    const matched = extraContacts[matchIdx];
    const remainingContacts = extraContacts.filter((_, i) => i !== matchIdx);
    const memberIds = hh.memberIds || [];
    const batch = db.batch();
    batch.update(snap.ref, {
      status: 'approved',
      householdIds: [hhDoc.id],
      phone: user.phone || matched.phone || '',
      birthdate: user.birthdate || matched.birthdate || null
    });
    batch.update(hhDoc.ref, {
      memberIds: memberIds.includes(event.params.uid) ? memberIds : [...memberIds, event.params.uid],
      extraContacts: remainingContacts
    });
    await batch.commit();
    console.log(`Auto-approved ${user.email} (uid ${event.params.uid}) into household ${hhDoc.id}, matched extraContacts entry "${matched.name}"`);
    return;
  }
  // No match — stays pending for the normal manual approval in Admin tab.
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
