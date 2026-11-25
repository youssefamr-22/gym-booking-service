'use strict';
// Builds the Express app and exports it (no app.listen), as in Lab 7.
// server.js runs it on your PC; lambda.js runs the very same app on Lambda.
const { createApp } = require('gym-shared');
const routes = require('./routes/bookings');

module.exports = createApp(routes.mount);
