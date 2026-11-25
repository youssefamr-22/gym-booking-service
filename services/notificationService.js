'use strict';
// Member notifications — external integration with the Brevo transactional
// email API (https://developers.brevo.com, free plan: 300 emails/day).
//
// Flow: logic.notify() / EventBridge rule (MemberSuspended) -> SQS gym-notifications
//       -> this consumer -> (1) in-app notification row in DynamoDB
//                           (2) email through Brevo
// The Brevo API key lives in AWS Secrets Manager (gym/booking-service/brevo-api-key)
// and is read at runtime; it is never in code, config files or the repository.
// If the secret value is "DISABLED" (e.g. during local development) the email is
// skipped and the in-app notification is still stored, with emailStatus=SKIPPED.

const crypto = require('crypto');
const { secrets, users, log, clock, metrics } = require('gym-shared');
const store = require('./bookingStore');

const BREVO_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
const SECRET_ID = process.env.BREVO_SECRET_ID || 'gym/booking-service/brevo-api-key';
const SENDER = { name: process.env.EMAIL_SENDER_NAME || 'Gym Class Booking', email: process.env.EMAIL_SENDER_ADDRESS || 'no-reply@example.com' };

const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' }) : '');
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function compose(kind, d) {
  switch (kind) {
    case 'WAITLIST_PROMOTED':
      return { title: 'You got a place!', message: `A place opened in ${d.classTitle} on ${fmt(d.classStart)} and it is now booked for you. Cancel from "My bookings" if you can no longer attend.` };
    case 'CLASS_CANCELLED':
      return { title: 'Class cancelled', message: `${d.classTitle} on ${fmt(d.classStart)} was cancelled by the gym${d.reason ? ` (${d.reason})` : ''}. Your booking/waitlist place has been released.` };
    case 'CLASS_RESCHEDULED':
      return { title: 'Class time changed', message: `${d.classTitle} moved from ${fmt(d.oldStartTime)} to ${fmt(d.classStart)}. Your place is kept.` };
    case 'BOOKING_CANCELLED_BY_GYM':
      return { title: 'Booking cancelled', message: `Your booking for ${d.classTitle} on ${fmt(d.classStart)} was cancelled by the gym.` };
    case 'MEMBER_SUSPENDED':
      return { title: 'Booking paused', message: `You reached ${d.strikes} no-shows/late cancellations in ${d.windowDays} days, so new bookings are paused until ${fmt(d.suspendedUntil)}.` };
    default:
      return { title: 'Gym update', message: 'There is an update to your bookings.' };
  }
}

async function sendEmail(to, title, message) {
  let apiKey;
  try {
    apiKey = await secrets.getSecret(SECRET_ID);
  } catch (err) {
    log.warn('EMAIL_SECRET_UNAVAILABLE', { reason: err.name });
    return 'SKIPPED';
  }
  if (!apiKey || apiKey.startsWith('DISABLED')) return 'SKIPPED';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: SENDER, to: [{ email: to.email, name: to.name }], subject: title,
        htmlContent: `<p>Hi ${esc(to.name)},</p><p>${esc(message)}</p><p>— Gym Class Booking</p>`,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      log.error('EMAIL_SEND_FAILED', { status: res.status });
      metrics.putMetric('EmailFailures');
      // 4xx is a permanent problem (bad key/sender); 5xx is retried by SQS.
      if (res.status >= 500) throw new Error(`brevo ${res.status}`);
      return 'FAILED';
    }
    log.info('EMAIL_SENT', { provider: 'brevo' });
    return 'SENT';
  } finally {
    clearTimeout(t);
  }
}

async function handleNotification(kind, detail) {
  const memberId = detail.memberId;
  const profile = await users.getProfile(memberId);
  const { title, message } = compose(kind, detail);
  const emailStatus = profile && profile.email ? await sendEmail(profile, title, message) : 'NO_EMAIL';
  const now = clock.now().toISOString();
  await store.put({
    TableName: store.T.notifications,
    Item: {
      memberId, sk: `${now}#${crypto.randomUUID()}`, kind, title, message, classId: detail.classId,
      emailStatus, createdAt: now, expiresAt: Math.floor(Date.now() / 1000) + 60 * 86400,
    },
  });
  log.info('NOTIFICATION_STORED', { memberId, kind, emailStatus });
}

module.exports = { handleNotification, compose };
