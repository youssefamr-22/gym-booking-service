'use strict';
// Event consumers for the Booking & Waitlist service.
//  gym-booking-events  <- EventBridge rule (source gym.class-service):
//        ClassCancelled, ClassRescheduled, ClassCapacityChanged
//  gym-notifications   <- direct SendMessage from this service +
//                         EventBridge rule (MemberSuspended from attendance-service)

const { events, log } = require('gym-shared');
const logic = require('./services/bookingService');
const notifier = require('./services/notificationService');

const BOOKING_QUEUE = process.env.BOOKING_EVENTS_QUEUE || 'gym-booking-events';
const NOTIFY_QUEUE = process.env.NOTIFICATIONS_QUEUE || 'gym-notifications';

async function onBookingEvent(type, detail) {
  if (type === 'ClassCancelled') return logic.onClassCancelled(detail);
  if (type === 'ClassRescheduled') return logic.onClassRescheduled(detail);
  if (type === 'ClassCapacityChanged') return logic.onCapacityChanged(detail);
  log.warn('EVENT_IGNORED', { type });
  return null;
}

async function onNotification(type, detail) {
  if (type === 'Notify') return notifier.handleNotification(detail.kind, detail);
  if (type === 'MemberSuspended') return notifier.handleNotification('MEMBER_SUSPENDED', detail);
  log.warn('EVENT_IGNORED', { type });
  return null;
}

module.exports = {
  startLocal() {
    if (process.env.DISABLE_WORKERS === 'true') return;
    events.startPoller(BOOKING_QUEUE, onBookingEvent);
    events.startPoller(NOTIFY_QUEUE, onNotification);
  },
  // One Lambda consumes both queues; the source queue ARN tells them apart.
  onSqs(type, detail, _record, queueArn) {
    return queueArn.endsWith(`:${NOTIFY_QUEUE}`) ? onNotification(type, detail) : onBookingEvent(type, detail);
  },
  onSchedule: null,
};
