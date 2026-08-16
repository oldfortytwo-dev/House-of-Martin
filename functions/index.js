const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const nodemailer = require('nodemailer');

initializeApp();
const db = getFirestore();

const GMAIL_USER = defineSecret('GMAIL_USER');
const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');

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
