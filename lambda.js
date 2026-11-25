'use strict';
// Lambda entry point (handler: lambda.handler). API Gateway requests go to the
// Express app through serverless-http; SQS messages and scheduled events go to workers.js.
const { makeHandler } = require('gym-shared');
const app = require('./app');
const workers = require('./workers');

module.exports.handler = makeHandler(app, { onSqs: workers.onSqs, onSchedule: workers.onSchedule });
