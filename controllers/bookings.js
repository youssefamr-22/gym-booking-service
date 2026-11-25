'use strict';
// Controller: reads the request, validates it, calls the services and chooses the HTTP response.
// Booking & Waitlist service — owner: Youssef Amr Sayed (248183)

const {
  auth, errors, validate, audit, internal, sdk, clock,
} = require('gym-shared');
const store = require('../services/bookingStore');
const logic = require('../services/bookingService');

const { z } = sdk.zod;
const v = validate.validate;
const uuid = z.string().uuid();
const bookingIdSchema = z.string().regex(/^[0-9a-f-]{36}#[0-9a-f-]{36}$/i);

const view = (b) => ({
  bookingId: b.bookingId, classId: b.classId, memberId: b.memberId, memberName: b.memberName,
  classTitle: b.classTitle, classStart: b.classStart, classEnd: b.classEnd, status: b.status,
  source: b.source, createdAt: b.createdAt, cancelledAt: b.cancelledAt,
});

// POST /api/bookings
const createBooking = [v(z.object({ classId: uuid }).strict()), async (req, res) => {
  const { booking, warnings } = await logic.book(req.user, req.body.classId, req.id);
  await audit.audit(req, 'BOOKING_CREATED', { targetType: 'booking', targetId: booking.bookingId });
  res.status(201).json({ booking: view(booking), warnings });
}];

// GET /api/bookings/mine
const listMyBookings = async (req, res) => {
  const list = await store.byMember(req.user.id);
  res.json({ bookings: list.map(view).sort((a, b) => b.classStart.localeCompare(a.classStart)) });
};

// GET /api/bookings
// Class roster for the assigned trainer or an admin.
const classRoster = [v(z.object({ classId: uuid }).strict(), 'query'), async (req, res) => {
  const cls = await logic.getClass(req.validQuery.classId, req.id);
  if (req.user.role === 'trainer' && cls.trainerId !== req.user.id) throw auth.denyNotOwner(req, 'NOT_ASSIGNED_TRAINER');
  const list = await store.byClass(cls.classId);
  const waitlist = await store.waitlistForClass(cls.classId);
  res.json({
    bookings: list.map(view),
    waitlist: waitlist.map((w, i) => ({ memberId: w.memberId, joinedAt: w.joinedAt, position: i + 1 })),
  });
}];

// DELETE /api/bookings/:bookingId
// DELETE carries no body (some gateways drop DELETE bodies); everything is in the URL.
const cancelBooking = async (req, res) => {
  const parsed = bookingIdSchema.safeParse(decodeURIComponent(req.params.bookingId));
  if (!parsed.success) throw errors.badRequest('VALIDATION_FAILED', 'Invalid booking id');
  const booking = await store.getBooking(parsed.data);
  if (!booking) throw errors.notFound('Booking');
  // Object-level authorization: members can only cancel their own booking.
  if (req.user.role !== 'admin' && booking.memberId !== req.user.id) throw auth.denyNotOwner(req, 'NOT_BOOKING_OWNER');
  const result = await logic.cancel(req.user, booking, req.id);
  await audit.audit(req, 'BOOKING_CANCELLED', {
    targetType: 'booking', targetId: booking.bookingId,
    details: { status: result.booking.status, promoted: result.promoted.length },
  });
  res.json({ booking: view(result.booking), lateCancellation: result.late, promotedFromWaitlist: result.promoted.length });
};

// POST /api/waitlist
const joinWaitlist = [v(z.object({ classId: uuid }).strict()), async (req, res) => {
  const { entry } = await logic.joinWaitlist(req.user, req.body.classId, req.id);
  await audit.audit(req, 'WAITLIST_JOINED', { targetType: 'class', targetId: entry.classId });
  res.status(201).json({ entry });
}];

// GET /api/waitlist/mine
const listMyWaitlist = async (req, res) => {
  const mine = await store.waitlistForMember(req.user.id);
  const out = [];
  for (const e of mine) {
    const queue = await store.waitlistForClass(e.classId);
    out.push({ classId: e.classId, classTitle: e.classTitle, classStart: e.classStart, joinedAt: e.joinedAt, position: queue.findIndex((x) => x.memberId === req.user.id) + 1, queueLength: queue.length });
  }
  res.json({ waitlist: out.sort((a, b) => a.classStart.localeCompare(b.classStart)) });
};

// DELETE /api/waitlist/:classId
// A member leaves their own entry (identity from the token, so no IDOR is possible);
// an admin may remove someone else's entry with ?memberId=
const leaveWaitlist = [v(z.object({ classId: uuid }), 'params'), v(z.object({ memberId: uuid.optional() }).strict(), 'query'), async (req, res) => {
  let memberId = req.user.id;
  if (req.validQuery.memberId && req.validQuery.memberId !== req.user.id) {
    if (req.user.role !== 'admin') throw auth.denyNotOwner(req, 'NOT_WAITLIST_OWNER');
    memberId = req.validQuery.memberId;
  }
  await logic.removeFromWaitlist(req.params.classId, memberId);
  await audit.audit(req, 'WAITLIST_LEFT', { targetType: 'class', targetId: req.params.classId, details: { memberId } });
  res.status(204).end();
}];

// GET /api/notifications/mine
const listMyNotifications = async (req, res) => {
  const list = await store.notificationsFor(req.user.id);
  res.json({ notifications: list.map((n) => ({ kind: n.kind, title: n.title, message: n.message, classId: n.classId, emailStatus: n.emailStatus, createdAt: n.createdAt })) });
};

// GET /internal/classes/:classId/roster
const internalRoster = [v(z.object({ classId: uuid }), 'params'), async (req, res) => {
  const list = (await store.byClass(req.params.classId)).filter((b) => b.status === 'CONFIRMED');
  res.json({ roster: list.map((b) => ({ bookingId: b.bookingId, memberId: b.memberId, memberName: b.memberName, source: b.source, createdAt: b.createdAt })) });
}];

// POST /internal/booking-counts
const internalBookingCounts = [v(z.object({ classIds: z.array(uuid).max(500) }).strict()), async (req, res) => {
  const seats = await store.seatsBatch(req.body.classIds);
  const counts = {};
  for (const id of req.body.classIds) counts[id] = { booked: (seats[id] && seats[id].booked) || 0, waitlist: (seats[id] && seats[id].waitlistCount) || 0 };
  res.json({ counts, at: clock.now().toISOString() });
}];

module.exports = {
  createBooking,
  listMyBookings,
  classRoster,
  cancelBooking,
  joinWaitlist,
  listMyWaitlist,
  leaveWaitlist,
  listMyNotifications,
  internalRoster,
  internalBookingCounts,
};
