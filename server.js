'use strict';
// Starts the app on your PC:  npm run dev   ->  http://localhost:3003
// It also starts the background workers (SQS pollers, scheduled jobs) that
// Lambda gets from event source mappings and EventBridge rules in the cloud.
require('dotenv').config(); // reads .env (copy .env.example to .env first)
const { log } = require('gym-shared');
const app = require('./app');
const workers = require('./workers');

const port = Number(process.env.PORT || 3003);
app.listen(port, () => {
  log.info('SERVICE_STARTED', { port });
  workers.startLocal();
});
