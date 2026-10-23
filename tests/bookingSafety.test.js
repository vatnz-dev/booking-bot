const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime, Settings } = require('luxon');
process.env.S1_ROLE_ID = 'student';
process.env.I1_ROLE_ID = 'instructor';
process.env.I3_ROLE_ID = 'senior-instructor';
const fixedNow = DateTime.fromISO('2026-10-20T19:00:00+13:00').toMillis();
Settings.now = () => fixedNow;
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports, loaded: true }; };
stub('../src/services/traffic', { formatSectorTraffic: async () => 'traffic', formatAerodromeTraffic: async () => 'traffic' });
stub('../src/services/positions', { validateVatnzPosition: async () => ({ valid: true, meta: { suffix: 'CTR' } }), evaluateBookingEligibility: () => ({ allowed: true, mentorRequired: false }) });
stub('../src/services/vatsim', { getVatsimId: async () => '1234567' });
stub('../src/services/soloEndorsements', { applySoloEndorsementOverride: async ({ baseEligibility }) => baseEligibility });
const { createInteractionHandlers } = require('../src/handlers/interactions');
const { createBookingLifecycle } = require('../src/services/bookingLifecycle');
const { resolveBookingWindow } = require('../src/utils/time');
const noop = () => {};
const member = (id, roles = [], bot = false) => ({ id, user: { id, bot, username: id, displayAvatarURL: () => 'https://example.com/avatar.png' }, roles: { cache: new Set(roles) }, send: async () => {} });
const timerNames = ['clearMentorTimers', 'clearExtensionSelectionTimer', 'clearBookingReminderTimer', 'scheduleBookingReminder', 'scheduleMentorTagTimeout', 'scheduleMentorApprovalTimeout', 'scheduleExtensionSelectionTimeout'];
function fixture(initial = {}) {
  const data = structuredClone(initial);
  const messages = {
    get: id => structuredClone(data[id]),
    all: () => Object.entries(data).map(([key, data]) => ({ key, data: structuredClone(data) })),
    set: (id, value) => { data[id] = structuredClone(value); }
  };
  const responses = [], deleted = [], posts = [];
  const guild = { id: 'guild' };
  const channel = { id: 'channel', guild, send: async payload => { posts.push(payload); return { id: `new-${posts.length}`, delete: async () => {} }; } };
  const dependencies = {
    messages, client: { users: { fetch: async id => member(id) } },
    isStaffMember: () => false, getBookingChannel: async () => channel,
    fetchBookingMessage: async b => ({ id: b.messageId, guild, embeds: [], react: async () => {}, delete: async () => deleted.push(b.messageId) }),
    sendAuditLog: async () => {}, eventThreadService: { findMatchingEventThreadForBooking: async () => null, refreshEventCoverageNotificationsForBooking: async () => {} },
    bookingLifecycle: Object.fromEntries(timerNames.map(k => [k, noop]))
  };
  const interaction = {
    user: member('owner').user, member: member('owner'), guild,
    options: { getUser: () => null },
    reply: async p => responses.push(p), editReply: async p => responses.push(p), followUp: async p => responses.push(p),
    deferReply: async () => {}, deferUpdate: async () => {}, isModalSubmit: () => true,
    fields: { getTextInputValue: key => ({ pos: 'NZAA_CTR', date: '21/10', start: '1900', end: '2100' })[key] }
  };
  return { data, messages, responses, deleted, posts, guild, channel, dependencies, interaction, handlers: createInteractionHandlers(dependencies) };
}
const booking = (id, extra = {}) => ({ messageId: id, position: 'NZCH_TWR', date: '21/10', start: 1900, end: 2100, extendedSectors: [], ...extra });

for (const other of [
  booking('B', { position: 'NZCH-B_CTR' }),
  booking('B', { position: 'NZCH-S_CTR', extendedSectors: ['NZCH-B_CTR'] }),
  booking('B', { position: 'NZAA_CTR' })
]) {
  test(`create rejects occupied main/inherited/optional coverage: ${other.position}`, async () => {
    const f = fixture({ other: [other] });
    const before = structuredClone(f.data);
    await f.handlers.handlePlan(f.interaction);
    assert.match(f.responses.at(-1).content, /already booked/);
    assert.deepEqual(f.data, before);
    assert.equal(f.posts.length, 0);
  });
}

test('create permits back-to-back coverage and ignores a different stored year', async () => {
  for (const other of [booking('B', { position: 'NZCH-B_CTR', start: 1700, end: 1900 }), booking('B', { position: 'NZCH-B_CTR', startUtc: '2027-10-21T06:00:00Z', endUtc: '2027-10-21T08:00:00Z' })]) {
    const f = fixture({ other: [other] });
    await f.handlers.handlePlan(f.interaction);
    assert.equal(f.posts.length, 1);
    assert.deepEqual(f.data.owner[0].extendedSectors, ['NZCH-B_CTR']);
  }
});

test('same-day past starts fail and New Year endpoints share the next occurrence year', () => {
  assert.equal(resolveBookingWindow('20/10', '1800', '2000'), null);
  const future = resolveBookingWindow('20/10', '2000', '2100');
  assert.equal(future.startNz.year, 2026);
  assert.equal(future.endNz.year, 2026);
  const nextYear = resolveBookingWindow('01/01', '1800', '2000');
  assert.equal(nextYear.startNz.year, 2027);
  assert.equal(nextYear.endNz.year, 2027);
  const active = booking('A', { date: '20/10', start: 1800, end: 2000, startUtc: '2026-10-20T05:00:00Z', endUtc: '2026-10-20T07:00:00Z' });
  assert.equal(resolveBookingWindow('20/10', '1800', '2100', active).startNz.year, 2026);
  assert.equal(resolveBookingWindow('20/10', '1800', '1830', active), null);
  assert.equal(resolveBookingWindow('26/09', '0230', '0400'), null); // NZ DST gap in 2027.
});

test('create rejects today past start without publishing or saving', async () => {
  const f = fixture();
  f.interaction.fields.getTextInputValue = key => ({ pos: 'NZAA_CTR', date: '20/10', start: '1800', end: '2000' })[key];
  await f.handlers.handlePlan(f.interaction);
  assert.match(f.responses.at(-1).content, /future start/);
  assert.equal(f.posts.length, 0);
  assert.deepEqual(f.data, {});
});

test('restart restores overdue mentor deadlines and remaining approval time without resetting them', async t => {
  const f = fixture({ owner: [
    booking('untagged', { mentorRequired: true, createdAt: '2026-10-20T05:00:00Z', reminderSentAt: 'sent' }),
    booking('pending', { mentorRequired: true, mentorId: 'mentor', mentorTaggedAt: '2026-10-20T05:45:00Z', reminderSentAt: 'sent' }),
    booking('approved', { mentorRequired: true, mentorApproved: true, reminderSentAt: 'sent' })
  ] });
  const scheduled = [];
  t.mock.method(global, 'setTimeout', (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; });
  t.mock.method(global, 'clearTimeout', noop);
  t.mock.method(global, 'setInterval', () => ({}));
  const lifecycle = createBookingLifecycle(f.dependencies);
  lifecycle.startBookingCleanupScheduler();
  assert.deepEqual(scheduled.map(t => t.delay), [1000, 15 * 60 * 1000]);
  await scheduled[0].callback();
  assert.deepEqual(f.data.owner.map(b => b.messageId), ['pending', 'approved']);
  await scheduled[1].callback();
  assert.deepEqual(f.data.owner.map(b => b.messageId), ['approved']);
});

test('new booking embed displays I1 when the controller also holds S1', async () => {
  const f = fixture();
  f.interaction.member = member('owner', ['student', 'instructor']);
  await f.handlers.handlePlan(f.interaction);
  assert.equal(f.posts[0].embeds[0].toJSON().footer.text, 'I1 - Instructor');
});
