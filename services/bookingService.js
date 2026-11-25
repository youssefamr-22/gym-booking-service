'use strict';
// Booking & Waitlist business logic — owner: Youssef Amr Sayed (248183)
//
// Rules
//  B1 only PUBLISHED classes that have not started can be booked
//  B2 the booking window opens `bookingWindowDays` before the class
//  B3 a suspended member (attendance-service decides) cannot book or join a waitlist
//  B4 a member can hold at most `maxActiveBookings` upcoming bookings
//  B5 seats are taken atomically: seat counter + booking in ONE DynamoDB transaction
//  B6 cancelling less than `lateCancelHours` before start is a LATE cancellation
//     -> event BookingLateCancelled -> attendance-service records a strike
//  B7 a freed seat is offered to the waitlist in FIFO order, skipping suspended
//     members, in a transaction (seat + booking + remove waitlist entry)
//  B8 the waitlist is only for full classes and holds at most `maxWaitlist` members

const crypto = require('crypto');
const {
  internal, errors, log, clock, policy, events, metrics, sdk, users,
} = require('gym-shared');
const { SendMessageCommand } = sdk.sqs;
const store = require('./bookingStore');

const POLICY_NAME = process.env.POLICY_PARAMETER || '/gym/booking-service/policy';
const DEFAULTS = { maxActiveBookings: 5, bookingWindowDays: 7, lateCancelHours: 2, maxWaitlist: 20 };
const NOTIFY_QUEUE = process.env.NOTIFICATIONS_QUEUE || 'gym-notifications';
const loadPolicy = () => policy.loadPolicy(POLICY_NAME, DEFAULTS);

async function getClass(classId, requestId) {
  try {
    const res = await internal.callService('class-service', 'GET', `/internal/classes/${classId}`, null, { requestId });
    return res.class;
  } catch (err) {
    if (err.status === 404) throw errors.notFound('Class');
    throw err;
  }
}

// B3. Fail-open if attendance-service is down (availability over a business
// penalty), but the decision is logged so it is visible in monitoring.
async function eligibility(memberId, requestId) {
  try {
    return await internal.callService('attendance-service', 'GET', `/internal/members/${memberId}/eligibility`, null, { requestId });
  } catch (err) {
    log.warn('ELIGIBILITY_UNKNOWN_FAIL_OPEN', { memberId, reason: err.code });
    return { eligible: true, unknown: true };
  }
}

function assertBookable(cls, p) {
  const now = clock.nowMs();
  const start = new Date(cls.startTime).getTime();
  if (cls.status !== 'PUBLISHED') throw errors.conflict('CLASS_NOT_BOOKABLE', `This class is ${cls.status.toLowerCase()}`);
  if (start <= now) throw errors.conflict('CLASS_ALREADY_STARTED', 'This class has already started');
  if (start - now > p.bookingWindowDays * 86400000) {
    throw errors.conflict('BOOKING_WINDOW_NOT_OPEN', `Bookings open ${p.bookingWindowDays} days before the class`);
  }
}

async function notify(memberId, kind, detail) {
  const { queueUrl } = events;
  const url = await queueUrl(NOTIFY_QUEUE);
  await require('gym-shared').aws.sqs().send(new SendMessageCommand({
    QueueUrl: url,
    MessageBody: JSON.stringify({ type: 'Notify', detail: { memberId, kind, ...detail } }),
  }));
}

async function book(user, classId, requestId) {
  const p = await loadPolicy();
  const cls = await getClass(classId, requestId);
  assertBookable(cls, p);
  const elig = await eligibility(user.id, requestId);
  if (!elig.eligible) {
    throw errors.forbidden('MEMBER_SUSPENDED', `Booking is suspended until ${elig.suspendedUntil} because of repeated no-shows/late cancellations`);
  }
  const mine = await store.byMember(user.id);
  const active = mine.filter((b) => b.status === 'CONFIRMED' && new Date(b.classStart).getTime() > clock.nowMs());
  if (active.some((b) => b.classId === classId)) throw errors.conflict('ALREADY_BOOKED', 'You already have a place in this class');
  if (active.length >= p.maxActiveBookings) {
    throw errors.conflict('BOOKING_LIMIT_REACHED', `You can hold at most ${p.maxActiveBookings} upcoming bookings`);
  }
  const profile = await users.getProfile(user.id);
  const now = clock.now().toISOString();
  const booking = {
    bookingId: store.bookingId(classId, user.id), classId, memberId: user.id,
    memberName: profile ? profile.name : 'Member', classTitle: cls.title, classStart: cls.startTime, classEnd: cls.endTime,
    status: 'CONFIRMED', source: 'DIRECT', createdAt: now, updatedAt: now,
  };
  try {
    await store.transact([
      {
        Update: {
          TableName: store.T.seats, Key: { classId },
          UpdateExpression: 'SET booked = if_not_exists(booked, :zero) + :one',
          ConditionExpression: 'attribute_not_exists(booked) OR booked < :cap',
          ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':cap': cls.capacity },
        },
      },
      {
        Put: {
          TableName: store.T.bookings, Item: booking,
          ConditionExpression: 'attribute_not_exists(bookingId) OR #s <> :confirmed',
          ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':confirmed': 'CONFIRMED' },
        },
      },
    ]);
  } catch (err) {
    if (err.name === 'TransactionCanceledException') {
      const idx = store.failedIndex(err);
      if (idx === 1) throw errors.conflict('ALREADY_BOOKED', 'You already have a place in this class');
      metrics.putMetric('BookingRejectedFull');
      const seats = await store.seats(classId);
      throw errors.conflict('CLASS_FULL', 'This class is full. You can join the waitlist.', { capacity: cls.capacity, waitlistCount: seats.waitlistCount || 0 });
    }
    throw err;
  }
  // If the member was on the waitlist and a seat was free, take them off it.
  const entry = await store.getWaitlistEntry(classId, user.id);
  if (entry) await removeFromWaitlist(classId, user.id).catch(() => {});
  metrics.putMetric('BookingsCreated');
  return { booking, warnings: elig.unknown ? ['Membership standing could not be verified'] : [] };
}

// B7: offer up to `seats` freed places to the waitlist (FIFO).
async function promote(cls, seatsToFill, requestId) {
  const promoted = [];
  if (seatsToFill <= 0 || cls.status !== 'PUBLISHED' || new Date(cls.startTime).getTime() <= clock.nowMs()) return promoted;
  const queue = await store.waitlistForClass(cls.classId);
  for (const entry of queue) {
    if (promoted.length >= seatsToFill) break;
    const elig = await eligibility(entry.memberId, requestId);
    if (!elig.eligible) {
      log.info('PROMOTION_SKIPPED_SUSPENDED', { classId: cls.classId, memberId: entry.memberId });
      continue;
    }
    const now = clock.now().toISOString();
    const profile = await users.getProfile(entry.memberId);
    const booking = {
      bookingId: store.bookingId(cls.classId, entry.memberId), classId: cls.classId, memberId: entry.memberId,
      memberName: profile ? profile.name : 'Member', classTitle: cls.title, classStart: cls.startTime, classEnd: cls.endTime,
      status: 'CONFIRMED', source: 'WAITLIST', createdAt: now, updatedAt: now,
    };
    try {
      await store.transact([
        {
          Update: {
            TableName: store.T.seats, Key: { classId: cls.classId },
            UpdateExpression: 'SET booked = if_not_exists(booked, :zero) + :one, waitlistCount = waitlistCount - :one',
            ConditionExpression: '(attribute_not_exists(booked) OR booked < :cap) AND waitlistCount > :zero',
            ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':cap': cls.capacity },
          },
        },
        { Delete: { TableName: store.T.waitlist, Key: { classId: cls.classId, memberId: entry.memberId }, ConditionExpression: 'attribute_exists(memberId)' } },
        {
          Put: {
            TableName: store.T.bookings, Item: booking,
            ConditionExpression: 'attribute_not_exists(bookingId) OR #s <> :confirmed',
            ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':confirmed': 'CONFIRMED' },
          },
        },
      ]);
    } catch (err) {
      if (err.name === 'TransactionCanceledException') {
        log.warn('PROMOTION_CONFLICT', { classId: cls.classId, memberId: entry.memberId, failed: store.failedIndex(err) });
        if (store.failedIndex(err) === 0) break; // class is full again
        continue;
      }
      throw err;
    }
    promoted.push(entry.memberId);
    metrics.putMetric('WaitlistPromotions');
    await notify(entry.memberId, 'WAITLIST_PROMOTED', { classId: cls.classId, classTitle: cls.title, classStart: cls.startTime })
      .catch((e) => log.error('NOTIFY_ENQUEUE_FAILED', { reason: e.name }));
  }
  return promoted;
}

async function cancel(user, booking, requestId) {
  const p = await loadPolicy();
  if (booking.status !== 'CONFIRMED') throw errors.conflict('BOOKING_NOT_ACTIVE', `Booking is already ${booking.status.toLowerCase()}`);
  const cls = await getClass(booking.classId, requestId);
  const start = new Date(cls.startTime).getTime();
  if (start <= clock.nowMs()) throw errors.conflict('CLASS_ALREADY_STARTED', 'A booking cannot be cancelled after the class has started');
  const byAdmin = user.role === 'admin' && booking.memberId !== user.id;
  const late = !byAdmin && start - clock.nowMs() < p.lateCancelHours * 3600000;
  const status = byAdmin ? 'CANCELLED_BY_GYM' : late ? 'LATE_CANCELLED' : 'CANCELLED';
  const now = clock.now().toISOString();
  try {
    await store.transact([
      {
        Update: {
          TableName: store.T.bookings, Key: { bookingId: booking.bookingId },
          UpdateExpression: 'SET #s = :s, cancelledAt = :now, updatedAt = :now, cancelledBy = :by',
          ConditionExpression: '#s = :confirmed',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': status, ':now': now, ':confirmed': 'CONFIRMED', ':by': user.id },
        },
      },
      {
        Update: {
          TableName: store.T.seats, Key: { classId: booking.classId },
          UpdateExpression: 'SET booked = booked - :one', ConditionExpression: 'booked > :zero',
          ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
        },
      },
    ]);
  } catch (err) {
    if (err.name === 'TransactionCanceledException') throw errors.conflict('BOOKING_NOT_ACTIVE', 'Booking was already cancelled');
    throw err;
  }
  if (late) {
    await events.publish('BookingLateCancelled', {
      bookingId: booking.bookingId, classId: booking.classId, memberId: booking.memberId,
      classStart: cls.startTime, cancelledAt: now, hoursBefore: Math.round(((start - clock.nowMs()) / 3600000) * 10) / 10,
    });
  }
  if (byAdmin) {
    await notify(booking.memberId, 'BOOKING_CANCELLED_BY_GYM', { classId: cls.classId, classTitle: cls.title, classStart: cls.startTime }).catch(() => {});
  }
  const promoted = await promote(cls, 1, requestId);
  return { booking: { ...booking, status, cancelledAt: now }, late, promoted };
}

async function joinWaitlist(user, classId, requestId) {
  const p = await loadPolicy();
  const cls = await getClass(classId, requestId);
  assertBookable(cls, p);
  const elig = await eligibility(user.id, requestId);
  if (!elig.eligible) throw errors.forbidden('MEMBER_SUSPENDED', `Suspended until ${elig.suspendedUntil}`);
  const existing = await store.getBooking(store.bookingId(classId, user.id));
  if (existing && existing.status === 'CONFIRMED') throw errors.conflict('ALREADY_BOOKED', 'You already have a place in this class');
  const seats = await store.seats(classId);
  if ((seats.booked || 0) < cls.capacity) throw errors.conflict('SEATS_AVAILABLE', 'Places are still available. Book directly instead.');
  const entry = { classId, memberId: user.id, joinedAt: clock.now().toISOString(), classTitle: cls.title, classStart: cls.startTime };
  try {
    await store.transact([
      {
        Update: {
          TableName: store.T.seats, Key: { classId },
          UpdateExpression: 'SET waitlistCount = if_not_exists(waitlistCount, :zero) + :one',
          ConditionExpression: 'attribute_not_exists(waitlistCount) OR waitlistCount < :max',
          ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':max': p.maxWaitlist },
        },
      },
      { Put: { TableName: store.T.waitlist, Item: entry, ConditionExpression: 'attribute_not_exists(memberId)' } },
    ]);
  } catch (err) {
    if (err.name === 'TransactionCanceledException') {
      if (store.failedIndex(err) === 1) throw errors.conflict('ALREADY_ON_WAITLIST', 'You are already on the waitlist');
      throw errors.conflict('WAITLIST_FULL', `The waitlist is full (${p.maxWaitlist})`);
    }
    throw err;
  }
  const position = (await store.waitlistForClass(classId)).findIndex((e) => e.memberId === user.id) + 1;
  return { entry: { ...entry, position } };
}

async function removeFromWaitlist(classId, memberId) {
  try {
    await store.transact([
      { Delete: { TableName: store.T.waitlist, Key: { classId, memberId }, ConditionExpression: 'attribute_exists(memberId)' } },
      {
        Update: {
          TableName: store.T.seats, Key: { classId }, UpdateExpression: 'SET waitlistCount = waitlistCount - :one',
          ConditionExpression: 'waitlistCount > :zero', ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
        },
      },
    ]);
  } catch (err) {
    if (err.name === 'TransactionCanceledException') throw errors.notFound('Waitlist entry');
    throw err;
  }
}

// ----- reactions to Class & Schedule events -----
async function onClassCancelled(detail) {
  const bookings = (await store.byClass(detail.classId)).filter((b) => b.status === 'CONFIRMED');
  const now = clock.now().toISOString();
  for (const b of bookings) {
    await store.update({
      TableName: store.T.bookings, Key: { bookingId: b.bookingId },
      UpdateExpression: 'SET #s = :s, cancelledAt = :now, updatedAt = :now, cancelReason = :r',
      ConditionExpression: '#s = :confirmed', ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'CANCELLED_BY_GYM', ':now': now, ':confirmed': 'CONFIRMED', ':r': detail.reason || 'Class cancelled' },
    }).catch((e) => { if (e.name !== 'ConditionalCheckFailedException') throw e; });
    await notify(b.memberId, 'CLASS_CANCELLED', { classId: detail.classId, classTitle: detail.title, classStart: detail.startTime, reason: detail.reason });
  }
  const waiting = await store.waitlistForClass(detail.classId);
  for (const w of waiting) {
    await removeFromWaitlist(detail.classId, w.memberId).catch(() => {});
    await notify(w.memberId, 'CLASS_CANCELLED', { classId: detail.classId, classTitle: detail.title, classStart: detail.startTime, reason: detail.reason });
  }
  await store.update({
    TableName: store.T.seats, Key: { classId: detail.classId }, UpdateExpression: 'SET booked = :zero, waitlistCount = :zero, cancelled = :t',
    ExpressionAttributeValues: { ':zero': 0, ':t': true },
  });
  log.info('CLASS_CANCELLATION_APPLIED', { classId: detail.classId, bookings: bookings.length, waitlist: waiting.length });
}

async function onClassRescheduled(detail) {
  const bookings = (await store.byClass(detail.classId)).filter((b) => b.status === 'CONFIRMED');
  for (const b of bookings) {
    await store.update({
      TableName: store.T.bookings, Key: { bookingId: b.bookingId },
      UpdateExpression: 'SET classStart = :s, classEnd = :e, updatedAt = :now',
      ExpressionAttributeValues: { ':s': detail.startTime, ':e': detail.endTime, ':now': clock.now().toISOString() },
    });
    await notify(b.memberId, 'CLASS_RESCHEDULED', { classId: detail.classId, classTitle: detail.title, classStart: detail.startTime, oldStartTime: detail.oldStartTime });
  }
  const waiting = await store.waitlistForClass(detail.classId);
  for (const w of waiting) {
    await store.update({ TableName: store.T.waitlist, Key: { classId: w.classId, memberId: w.memberId }, UpdateExpression: 'SET classStart = :s', ExpressionAttributeValues: { ':s': detail.startTime } });
  }
}

async function onCapacityChanged(detail) {
  if (detail.capacity <= detail.oldCapacity) return;
  const cls = await getClass(detail.classId);
  const seats = await store.seats(detail.classId);
  const free = cls.capacity - (seats.booked || 0);
  const promoted = await promote(cls, free);
  log.info('CAPACITY_INCREASE_PROMOTIONS', { classId: detail.classId, free, promoted: promoted.length });
}

module.exports = {
  loadPolicy, book, cancel, promote, joinWaitlist, removeFromWaitlist, getClass, notify,
  onClassCancelled, onClassRescheduled, onCapacityChanged, newId: () => crypto.randomUUID(),
};
