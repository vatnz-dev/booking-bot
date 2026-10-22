// One JSON line per event on stdout, so container logs can be searched and traced.
function log(level, event, fields = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }, (key, value) =>
    value instanceof Error
      ? { message: value.message, code: value.code ?? value.cause?.code, status: value.response?.status, stack: value.stack }
      : value);
  (level === 'error' ? console.error : console.log)(line);
}

// Wraps an async task so a failure is logged with its context instead of becoming an unhandled rejection.
function logFailures(task, context, fn) {
  return (...args) => Promise.resolve()
    .then(() => fn(...args))
    .catch(error => log('error', 'task_failed', { task, ...context, error }));
}

// Non-secret settings safe to log at startup; tests keep this in step with .env.example.
const LOGGED_SETTINGS = [
  'GUILD_ID', 'CHANNEL_ID', 'LOG_CHANNEL_ID', 'BOT_OWNER_IDS', 'BOARD_ROLE_ID', 'SENIOR_STAFF_ROLE_ID',
  'BOOKING_MODERATOR_ROLE_IDS', 'EVENT_THREAD_ROLE_IDS', 'EVENT_PROMPT_ROLE_IDS', 'EVENT_POSITION_USER_IDS',
  'MENTOR_APPROVER_USER_IDS', 'EVENT_NOTIFICATIONS_ROLE_ID', 'FSS_ROLE_ID',
  'TRAINING_TEAM_ROLE_ID', 'S1_ROLE_ID', 'S2_ROLE_ID', 'S3_ROLE_ID', 'C1_ROLE_ID', 'C3_ROLE_ID', 'I1_ROLE_ID', 'I3_ROLE_ID',
  'BOOKING_REMINDERS_ENABLED', 'BOOKING_REMINDER_MINUTES', 'EVENT_CHECK_INTERVAL_MS', 'EVENT_CALENDAR_URL',
  'VATNZ_POSITIONS_URL', 'SOLO_ENDORSEMENTS_URL', 'S1_SOLO_ENDORSEMENTS_URL', 'STATSIM_ENABLED', 'STATSIM_TIMEOUT_MS',
  'STATSIM_HEALTH_CHECK_MINUTES', 'STATSIM_ZERO_FALLBACK_YEARS'
];

// URLs lose their credentials and query strings, which can hold feed tokens.
function describeSettings(env) {
  return Object.fromEntries(LOGGED_SETTINGS.filter(name => env[name] !== undefined).map(name =>
    [name, name.endsWith('_URL') ? env[name].replace(/\/\/[^/@]*@/, '//').split('?')[0] : env[name]]));
}

module.exports = { log, logFailures, describeSettings, LOGGED_SETTINGS };
