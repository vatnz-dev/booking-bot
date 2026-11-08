const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports, loaded: true }; };
stub('../src/data/databases', { settings: { get: () => ({ enabled: false }) } });
stub('../src/services/traffic', { formatSectorTraffic: async () => 'traffic', formatAerodromeTraffic: async () => 'traffic' });
const { createInteractionHandlers } = require('../src/handlers/interactions');
const { createBookingLifecycle } = require('../src/services/bookingLifecycle');
const { registerProcessHandlers, CRASH_POST_WAIT_MS } = require('../src/handlers/process');

const capture = t => {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(JSON.parse(line)));
  t.mock.method(console, 'error', line => lines.push(JSON.parse(line)));
  return lines;
};
function store(initial) {
  const data = new Map(Object.entries(initial));
  return { data, get: k => data.get(k), set: (k, v) => data.set(k, v), all: () => [...data].map(([key, value]) => ({ key, data: value })) };
}
const window = { date: '14/11', start: 1800, end: 2000, startUtc: '2099-11-14T05:00:00.000Z', endUtc: '2099-11-14T07:00:00.000Z' };

test('choosing extra sectors after booking is audited, naming the sectors added and any already taken', async () => {
  const messages = store({
    sam: [{ ...window, messageId: 'm', position: 'NZCH-S_CTR', extendedSectors: [], awaitingExtensionSelection: true }],
    alex: [{ ...window, messageId: 'other', position: 'NZCH-T_CTR', extendedSectors: [] }]
  });
  const audits = [];
  const h = createInteractionHandlers({
    messages,
    sendAuditLog: async entry => audits.push(entry),
    fetchBookingMessage: async () => ({ embeds: [{ color: 0, title: 'NZCH-S_CTR', fields: [] }], edit: async () => {} }),
    bookingLifecycle: { clearExtensionSelectionTimer: () => {} },
    eventThreadService: { refreshEventCoverageNotificationsForBooking: async () => {} }
  });
  await h.handleExtendSectorSelect({
    member: { user: { id: 'sam' } }, user: { id: 'sam' }, values: ['m|NZCH-B_CTR', 'm|NZCH-T_CTR'],
    deferUpdate: async () => {}, editReply: async () => {}, followUp: async () => {}
  });
  const audit = audits.find(a => a.action === 'Sector Extensions Changed');
  assert.ok(audit, 'Sector Extensions Changed is audited');
  assert.equal(audit.targetUserId, 'sam');
  assert.deepEqual(audit.fields.map(f => f.name), ['Added', 'Already taken, not added']);
  assert.match(audit.fields[0].value, /NZCH-B_CTR|BAY/);
  assert.deepEqual(messages.data.get('sam')[0].extendedSectors, ['NZCH-B_CTR']);
});

test('a DM sent and a message deleted each leave a log line with the recipient or message ID and the reason', async t => {
  const lines = capture(t);
  const messages = store({ sam: [{ ...window, messageId: 'm', position: 'NZAA_TWR', mentorRequired: true }] });
  const lifecycle = createBookingLifecycle({
    client: { users: { fetch: async () => ({ send: async () => {} }) } },
    messages,
    sendAuditLog: async () => {},
    fetchBookingMessage: async () => ({ delete: async () => {} })
  });
  await lifecycle.removeBookingAndNotify({ ownerId: 'sam', messageId: 'm', dmText: 'deleted', auditAction: 'Mentor Tag Timeout Auto-Delete' });
  const deleted = lines.find(l => l.event === 'message_deleted');
  const dm = lines.find(l => l.event === 'dm_sent');
  assert.deepEqual([deleted.messageId, deleted.reason], ['m', 'Mentor Tag Timeout Auto-Delete']);
  assert.deepEqual([dm.userId, dm.reason], ['sam', 'Mentor Tag Timeout Auto-Delete']);
});

function processHarness(sendAuditLog) {
  const proc = new EventEmitter();
  const client = new EventEmitter();
  const exits = [];
  registerProcessHandlers({ processRef: proc, client, sendAuditLog, exit: code => exits.push(code) });
  return { proc, client, exits };
}

test('a crash is logged, posted to the log channel, and the bot exits', async t => {
  const lines = capture(t);
  const audits = [];
  const { proc, exits } = processHarness(async entry => { audits.push(entry); });
  proc.emit('uncaughtException', new Error('boom'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lines.find(l => l.event === 'uncaught_exception').error.message, 'boom');
  assert.ok(lines.find(l => l.event === 'uncaught_exception').error.stack, 'the stack trace is logged');
  assert.deepEqual(audits.map(a => [a.action, a.reason]), [['Unhandled Error', 'boom']]);
  assert.deepEqual(exits, [1]);
});

test('a crash still exits when the log channel post hangs', t => {
  capture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { proc, exits } = processHarness(() => new Promise(() => {}));
  proc.emit('uncaughtException', new Error('boom'));
  t.mock.timers.tick(CRASH_POST_WAIT_MS);
  assert.deepEqual(exits, [1]);
});

test('Discord disconnects, reconnects and resumes are logged', t => {
  const lines = capture(t);
  const { client } = processHarness(async () => {});
  client.emit('shardDisconnect', { code: 1006, reason: '' }, 0);
  client.emit('shardReconnecting', 0);
  client.emit('shardResume', 0, 12);
  assert.deepEqual(lines.map(l => [l.event, l.shardId]), [['discord_disconnected', 0], ['discord_reconnecting', 0], ['discord_resumed', 0]]);
  assert.equal(lines[0].code, 1006);
});
