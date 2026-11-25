'use strict';
// Booking & Waitlist service — owner: Youssef Amr Sayed (248183)
//
// Functions
//  F1 Book a place (atomic, rule-checked)         POST   /api/bookings
//  F2 Cancel with late-cancel policy + promotion  DELETE /api/bookings/:bookingId
//  F3 Waitlist join / leave / my positions        POST   /api/waitlist, DELETE /api/waitlist/:classId, GET /api/waitlist/mine
//  F4 My bookings / class roster (staff)          GET    /api/bookings/mine, GET /api/bookings?classId=
//  F5 Reactions to class events + notifications   (workers.js) GET /api/notifications/mine
// Internal (x-internal-key): GET /internal/classes/:classId/roster, POST /internal/booking-counts
//
// Routes: match an HTTP method and path, check who may call it (auth middleware),
// then hand the request to a controller function. No business logic here.

const { auth, internal } = require('gym-shared');
const controller = require('../controllers/bookings');

function mount(app) {
  app.post('/api/bookings', auth.authenticate, auth.requireRole('member'), controller.createBooking);
  app.get('/api/bookings/mine', auth.authenticate, auth.requireRole('member'), controller.listMyBookings);
  app.get('/api/bookings', auth.authenticate, auth.requireRole('trainer', 'admin'), controller.classRoster);
  app.delete('/api/bookings/:bookingId', auth.authenticate, auth.requireRole('member', 'admin'), controller.cancelBooking);
  app.post('/api/waitlist', auth.authenticate, auth.requireRole('member'), controller.joinWaitlist);
  app.get('/api/waitlist/mine', auth.authenticate, auth.requireRole('member'), controller.listMyWaitlist);
  app.delete('/api/waitlist/:classId', auth.authenticate, auth.requireRole('member', 'admin'), controller.leaveWaitlist);
  app.get('/api/notifications/mine', auth.authenticate, controller.listMyNotifications);
  // ---------- Internal API ----------
  app.get('/internal/classes/:classId/roster', internal.requireInternalKey, controller.internalRoster);
  app.post('/internal/booking-counts', internal.requireInternalKey, controller.internalBookingCounts);
}

module.exports = { mount };
