const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function stub(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = { exports, loaded: true };
}
stub('../src/data/databases', { settings: { get: () => ({ enabled: false }) } });
const { createAuditLogger } = require('../src/services/auditLog');
const { logFailures, describeSettings, LOGGED_SETTINGS } = require('../src/utils/log');

test('startup settings cover every non-secret .env.example key and never include secrets', () => {
  const documented = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8')
    .split('\n').map(line => line.match(/^([A-Z0-9_]+)=/)?.[1]).filter(Boolean);
  assert.deepEqual(documented.filter(name => name !== 'DISCORD_TOKEN' && !LOGGED_SETTINGS.includes(name)), []);
  const settings = describeSettings({
    DISCORD_TOKEN: 'secret', AWS_ACCESS_KEY_ID: 'secret', CHANNEL_ID: '123',
    EVENT_CALENDAR_URL: 'https://user:pw@example.org/cal.ics?token=secret'
  });
  assert.deepEqual(settings, { CHANNEL_ID: '123', EVENT_CALENDAR_URL: 'https://example.org/cal.ics' });
});
const { createInteractionHandlers } = require('../src/handlers/interactions');

function captureLogs(t, method) {
  const lines = [];
  t.mock.method(console, method, line => lines.push(JSON.parse(line)));
  return lines;
}

function auditFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'audit.jsonl');
  return { file, read: () => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

test('audit entries are written to the file and posted to the log channel', async t => {
  const { file, read } = auditFile(t);
  const posts = [];
  const { sendAuditLog } = createAuditLogger({ getLogChannel: async () => ({ send: async p => posts.push(p) }), getBookingMessageLink: () => null, auditFilePath: file });
  await sendAuditLog({ action: 'Booking Deleted', actorId: 'events-member', targetUserId: 'sam' });
  assert.equal(posts.length, 1);
  const [entry] = read();
  assert.equal(entry.action, 'Booking Deleted');
  assert.equal(entry.targetUserId, 'sam');
  assert.ok(entry.time);
});

test('audit entries survive a missing or failing log channel, and the failure is recorded', async t => {
  captureLogs(t, 'error');
  for (const getLogChannel of [async () => null, async () => ({ send: async () => { throw new Error('Missing Access'); } })]) {
    const { file, read } = auditFile(t);
    const { sendAuditLog } = createAuditLogger({ getLogChannel, getBookingMessageLink: () => null, auditFilePath: file });
    await sendAuditLog({ action: 'Booking Deleted' });
    const [entry, failure] = read();
    assert.equal(entry.action, 'Booking Deleted');
    assert.equal(failure.action, 'Log Channel Post Failed');
    assert.equal(failure.originalAction, 'Booking Deleted');
  }
});

test('a failing scheduled task is logged with its context and does not reject', async t => {
  const errors = captureLogs(t, 'error');
  await logFailures('mentor_tag_timeout', { messageId: 'post' }, async () => { throw new Error('Discord 503'); })();
  assert.equal(errors[0].event, 'task_failed');
  assert.equal(errors[0].task, 'mentor_tag_timeout');
  assert.equal(errors[0].messageId, 'post');
  assert.equal(errors[0].error.message, 'Discord 503');
  assert.match(errors[0].error.stack, /Discord 503/);
});

test('every interaction produces one traceable log line', async t => {
  const lines = captureLogs(t, 'log');
  let onInteraction;
  const { registerInteractionHandlers } = createInteractionHandlers({ client: { on: (_, fn) => { onInteraction = fn; } }, bookingLifecycle: {}, eventThreadService: {} });
  registerInteractionHandlers();
  await onInteraction({ id: 'i-1', commandName: 'unknowncommand', user: { id: 'sam' }, guildId: 'vatnz', channelId: 'bookings', isChatInputCommand: () => true });
  const [line] = lines.filter(l => l.event === 'interaction');
  assert.deepEqual({ ...line, time: undefined, ms: undefined }, {
    time: undefined, ms: undefined, level: 'info', event: 'interaction', name: 'unknowncommand',
    userId: 'sam', guildId: 'vatnz', channelId: 'bookings', interactionId: 'i-1', result: 'ok'
  });
});
