const axios = require('axios');

const { version } = require('../../package.json');
const { log } = require('./log');

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETRY_AFTER_MS = 60000;
const blockedUntil = new Map();

function userAgent() {
  return `VATNZ-Booking-Bot/${version} (+${process.env.BOT_CONTACT_URL}; ${process.env.BOT_CONTACT_EMAIL})`;
}

// Retry-After is either seconds or an HTTP date.
function retryAfterMs(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, date - Date.now());
}

// Every outside request goes through here: contact details, limits, rate-limit backoff and one log line each.
async function get(url, config = {}) {
  const { hostname, pathname } = new URL(url);
  const startedAt = Date.now();
  if ((blockedUntil.get(hostname) || 0) > startedAt) {
    throw Object.assign(new Error(`${hostname} is rate limited; not retrying yet`), { code: 'RATE_LIMITED' });
  }

  try {
    const response = await axios.get(url, {
      timeout: DEFAULT_TIMEOUT_MS,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
      maxRedirects: 2,
      beforeRedirect: options => {
        if (options.hostname !== hostname) throw new Error(`Refused redirect from ${hostname} to ${options.hostname}`);
      },
      ...config,
      headers: { 'User-Agent': userAgent(), ...config.headers }
    });
    log('info', 'http_request', { host: hostname, path: pathname, status: response.status, ms: Date.now() - startedAt });
    return response;
  } catch (error) {
    if (error.response?.status === 429) {
      blockedUntil.set(hostname, Date.now() + retryAfterMs(error.response.headers?.['retry-after']));
    }
    log('warn', 'http_request_failed', { host: hostname, path: pathname, status: error.response?.status, ms: Date.now() - startedAt, error });
    throw error;
  }
}

module.exports = { get };
