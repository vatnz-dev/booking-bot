const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.BOT_CONTACT_EMAIL = 'bot@example.org';
process.env.BOT_CONTACT_URL = 'https://github.com/vatnz-dev/booking-bot';
const http = require('../src/utils/http');
const { version } = require('../package.json');

function captureLogs(t) {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(JSON.parse(line)));
  return lines;
}

test('every request carries the contact User-Agent, limits and one log line without the query string', async t => {
  const lines = captureLogs(t);
  let seen;
  t.mock.method(axios, 'get', async (url, config) => { seen = { url, config }; return { status: 200, data: 'ok' }; });
  await http.get('https://www.vatnz.net/events/calendar.ics?token=secret', { timeout: 15000 });
  assert.equal(seen.config.headers['User-Agent'], `VATNZ-Booking-Bot/${version} (+https://github.com/vatnz-dev/booking-bot; bot@example.org)`);
  assert.equal(seen.config.timeout, 15000);
  assert.equal(seen.config.maxContentLength, 5 * 1024 * 1024);
  assert.equal(seen.config.maxRedirects, 2);
  const [line] = lines.filter(l => l.event === 'http_request');
  assert.deepEqual({ host: line.host, path: line.path, status: line.status }, { host: 'www.vatnz.net', path: '/events/calendar.ics', status: 200 });
  assert.doesNotMatch(JSON.stringify(lines), /secret/);
});

test('the default timeout is 10 seconds', async t => {
  captureLogs(t);
  let seen;
  t.mock.method(axios, 'get', async (url, config) => { seen = config; return { status: 200 }; });
  await http.get('https://www.vatnz.net/airspace/positions/');
  assert.equal(seen.timeout, 10000);
});

test('a redirect to another site is refused', async t => {
  captureLogs(t);
  let seen;
  t.mock.method(axios, 'get', async (url, config) => { seen = config; return { status: 200 }; });
  await http.get('https://www.vatnz.net/');
  assert.doesNotThrow(() => seen.beforeRedirect({ hostname: 'www.vatnz.net' }));
  assert.throws(() => seen.beforeRedirect({ hostname: 'evil.example.com' }), /Refused redirect/);
});

test('after HTTP 429 the host is not called again until Retry-After has passed', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  captureLogs(t);
  t.mock.method(console, 'error', () => {});
  let calls = 0;
  t.mock.method(axios, 'get', async () => {
    calls++;
    throw Object.assign(new Error('Request failed with status code 429'), { response: { status: 429, headers: { 'retry-after': '120' } } });
  });
  await assert.rejects(http.get('https://api.vatsim.net/v2/members/discord/1'), /429/);
  t.mock.timers.tick(30 * 1000);
  await assert.rejects(http.get('https://api.vatsim.net/v2/members/discord/2'), err => err.code === 'RATE_LIMITED');
  assert.equal(calls, 1);
  t.mock.timers.tick(91 * 1000);
  await assert.rejects(http.get('https://api.vatsim.net/v2/members/discord/3'), /429/);
  assert.equal(calls, 2);
});
