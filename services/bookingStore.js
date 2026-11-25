'use strict';
// Data access for the Booking & Waitlist service.
// Tables (DynamoDB):
//   gym-bookings     PK bookingId (= "<classId>#<memberId>": one booking per member per class)
//                    GSI byClass  (classId,  createdAt)
//                    GSI byMember (memberId, createdAt)
//   gym-class-seats  PK classId   { booked, waitlistCount } - the seat counter
//   gym-waitlist     PK classId, SK memberId { joinedAt }   GSI byMember (memberId, joinedAt)
//   gym-notifications PK memberId, SK sk ("<iso>#<uuid>")
// Overbooking is prevented by DynamoDB transactions with condition
// expressions, so two simultaneous requests for the last seat cannot both win.

const { aws, sdk } = require('gym-shared');

const {
  GetCommand, PutCommand, QueryCommand, UpdateCommand, TransactWriteCommand, BatchGetCommand,
} = sdk.ddb;
const ddb = () => aws.ddbDoc();
const T = {
  bookings: process.env.BOOKINGS_TABLE || 'gym-bookings',
  seats: process.env.SEATS_TABLE || 'gym-class-seats',
  waitlist: process.env.WAITLIST_TABLE || 'gym-waitlist',
  notifications: process.env.NOTIFICATIONS_TABLE || 'gym-notifications',
};

const bookingId = (classId, memberId) => `${classId}#${memberId}`;

async function queryAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb().send(new QueryCommand({ ...params, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// Returns the index of the failed condition in a cancelled transaction.
function failedIndex(err) {
  const reasons = err.CancellationReasons || [];
  const idx = reasons.findIndex((r) => r && r.Code === 'ConditionalCheckFailed');
  if (idx >= 0) return idx;
  // Some emulators only put the reasons in the message: "[ConditionalCheckFailed, None]"
  const m = /\[([^\]]+)\]/.exec(err.message || '');
  if (m) return m[1].split(',').map((s) => s.trim()).findIndex((s) => s === 'ConditionalCheckFailed');
  return -1;
}

module.exports = {
  T,
  bookingId,
  failedIndex,
  async getBooking(id) {
    return (await ddb().send(new GetCommand({ TableName: T.bookings, Key: { bookingId: id } }))).Item || null;
  },
  async seats(classId) {
    return (await ddb().send(new GetCommand({ TableName: T.seats, Key: { classId } }))).Item || { classId, booked: 0, waitlistCount: 0 };
  },
  async seatsBatch(classIds) {
    const out = {};
    const ids = [...new Set(classIds)];
    for (let i = 0; i < ids.length; i += 100) {
      const res = await ddb().send(new BatchGetCommand({ RequestItems: { [T.seats]: { Keys: ids.slice(i, i + 100).map((classId) => ({ classId })) } } }));
      for (const it of (res.Responses && res.Responses[T.seats]) || []) out[it.classId] = it;
    }
    return out;
  },
  byClass(classId) {
    return queryAll({ TableName: T.bookings, IndexName: 'byClass', KeyConditionExpression: 'classId = :c', ExpressionAttributeValues: { ':c': classId } });
  },
  byMember(memberId) {
    return queryAll({ TableName: T.bookings, IndexName: 'byMember', KeyConditionExpression: 'memberId = :m', ExpressionAttributeValues: { ':m': memberId }, ScanIndexForward: false });
  },
  waitlistForClass(classId) {
    return queryAll({ TableName: T.waitlist, KeyConditionExpression: 'classId = :c', ExpressionAttributeValues: { ':c': classId } })
      .then((items) => items.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt)));
  },
  waitlistForMember(memberId) {
    return queryAll({ TableName: T.waitlist, IndexName: 'byMember', KeyConditionExpression: 'memberId = :m', ExpressionAttributeValues: { ':m': memberId } });
  },
  async getWaitlistEntry(classId, memberId) {
    return (await ddb().send(new GetCommand({ TableName: T.waitlist, Key: { classId, memberId } }))).Item || null;
  },
  transact(items) {
    return ddb().send(new TransactWriteCommand({ TransactItems: items }));
  },
  update(params) {
    return ddb().send(new UpdateCommand(params));
  },
  put(params) {
    return ddb().send(new PutCommand(params));
  },
  notificationsFor(memberId) {
    return ddb().send(new QueryCommand({ TableName: T.notifications, KeyConditionExpression: 'memberId = :m', ExpressionAttributeValues: { ':m': memberId }, ScanIndexForward: false, Limit: 50 }))
      .then((r) => r.Items || []);
  },
};
