const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime, Settings } = require('luxon');
process.env.I1_ROLE_ID = 'instructor';
process.env.I3_ROLE_ID = 'senior-instructor';
delete process.env.MENTOR_ROLE_IDS;
const fixedNow = DateTime.fromISO('2026-10-20T19:00:00+13:00').toMillis();
Settings.now = () => fixedNow;
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports, loaded: true }; };
stub('../src/services/traffic', { formatSectorTraffic: async () => 'traffic', formatAerodromeTraffic: async () => 'traffic' });
stub('../src/services/positions', { validateVatnzPosition: async () => ({ valid: true, meta: { suffix: 'CTR' } }), evaluateBookingEligibility: () => ({ allowed: true, mentorRequired: false }) });
stub('../src/services/vatsim', { getVatsimId: async () => '1234567' });
stub('../src/services/soloEndorsements', { applySoloEndorsementOverride: async ({ baseEligibility }) => baseEligibility });
const { createInteractionHandlers } = require('../src/handlers/interactions');
const { createBookingLifecycle } = require('../src/services/bookingLifecycle');
const { createEventThreadService } = require('../src/services/eventThreads');
const { createBookingMutationQueue } = require('../src/utils/bookingMutations');
const { resolveBookingWindow } = require('../src/utils/time');
const { isEligibleMentor } = require('../src/utils/mentor');
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
  const mentor = member('mentor', ['instructor']);
  const guild = { id: 'guild', members: { cache: new Map([['mentor', mentor]]), fetch: async id => id === 'mentor' ? mentor : member(id) } };
  const channel = { id: 'channel', guild, send: async payload => { posts.push(payload); return { id: `new-${posts.length}`, delete: async () => {} }; } };
  const runBookingMutation = createBookingMutationQueue();
  const dependencies = {
    messages, runBookingMutation, client: { users: { fetch: async id => member(id) } },
    isStaffMember: () => false, getBookingChannel: async () => channel,
    fetchBookingMessage: async b => ({ id: b.messageId, guild, embeds: [], react: async () => {}, delete: async () => deleted.push(b.messageId) }),
    sendAuditLog: async () => {}, eventThreadService: { findMatchingEventThreadForBooking: async () => null, refreshEventCoverageNotificationsForBooking: async () => {} },
    bookingLifecycle: Object.fromEntries(timerNames.map(k => [k, noop]))
  };
  const interaction = {
    user: member('owner').user, member: member('owner'), guild,
    options: { getUser: () => null, getMember: () => mentor },
    reply: async p => responses.push(p), editReply: async p => responses.push(p), followUp: async p => responses.push(p),
    deferReply: async () => {}, deferUpdate: async () => {}, isModalSubmit: () => true,
    fields: { getTextInputValue: key => ({ pos: 'NZAA_CTR', date: '21/10', start: '1900', end: '2100' })[key] }
  };
  return { data, messages, responses, deleted, posts, mentor, guild, channel, dependencies, interaction, handlers: createInteractionHandlers(dependencies) };
}
const booking = (id, extra = {}) => ({ messageId: id, position: 'NZCH_TWR', date: '21/10', start: 1900, end: 2100, extendedSectors: [], ...extra });

test('delete picker keeps identity after a preceding booking disappears and rejects stale/legacy values', async () => {
  const f = fixture({ owner: [booking('A'), booking('B'), booking('C')] });
  await f.handlers.handleDeleteBookings(f.interaction);
  const options = f.responses[0].components[0].toJSON().components[0].options;
  f.data.owner.shift();
  await f.handlers.handleDeleteBookingSelect({ ...f.interaction, values: [options[1].value] });
  assert.deepEqual(f.deleted, ['B']);
  for (const value of [options[0].value, options[1].value, 'owner|0', '0']) {
    await f.handlers.handleDeleteBookingSelect({ ...f.interaction, values: [value] });
  }
  assert.deepEqual(f.data.owner.map(b => b.messageId), ['C']);
});

test('mentor roles deny self, bots and unrated users and allow configured non-instructor mentors', () => {
  assert.equal(isEligibleMentor(member('owner', ['instructor']), 'owner'), false);
  assert.equal(isEligibleMentor(member('bot', ['instructor'], true), 'owner'), false);
  assert.equal(isEligibleMentor(member('other'), 'owner'), false);
  assert.equal(isEligibleMentor(member('other', ['instructor']), 'owner'), true);
  process.env.MENTOR_ROLE_IDS = ' mentor-role, mentor-role ';
  try {
    assert.equal(isEligibleMentor(member('other', ['mentor-role']), 'owner'), true);
    assert.equal(isEligibleMentor(member('other', ['instructor']), 'owner'), false);
  } finally { delete process.env.MENTOR_ROLE_IDS; }
});

test('mentor selection uses stable identity and checks current membership roles', async () => {
  const f = fixture({ owner: [booking('A'), booking('B', { mentorRequired: true })] });
  await f.handlers.handleMentor(f.interaction);
  const values = f.responses[0].components[0].toJSON().components[0].options.map(o => o.value);
  f.data.owner.shift();
  await f.handlers.handleMentorBookingSelect({ ...f.interaction, values: [values[0]] });
  assert.equal(f.data.owner[0].mentorId, undefined);
  f.mentor.roles.cache.clear();
  await f.handlers.handleMentorBookingSelect({ ...f.interaction, values: [values[1]] });
  assert.equal(f.data.owner[0].mentorId, undefined);
  f.mentor.roles.cache.add('instructor');
  await f.handlers.handleMentorBookingSelect({ ...f.interaction, values: [values[1]] });
  assert.equal(f.data.owner[0].mentorId, 'mentor');
  await f.handlers.handleMentorBookingSelect({ ...f.interaction, values: ['id:B|owner'] });
  assert.equal(f.data.owner[0].mentorId, 'mentor');
});

test('approval rejects legacy self-tags, role loss and other users, then accepts designated mentor', async () => {
  const f = fixture({ owner: [booking('A', { mentorRequired: true, mentorId: 'owner' })] });
  const lifecycle = createBookingLifecycle({ ...f.dependencies, fetchBookingMessage: async () => null });
  const reaction = { emoji: { name: '\u{1F44D}' }, message: { id: 'A', guild: f.guild } };
  await lifecycle.handleMentorApprovalReaction(reaction, { id: 'owner' });
  assert.ok(!f.data.owner[0].mentorApproved);
  f.data.owner[0].mentorId = 'mentor';
  f.mentor.roles.cache.clear();
  await lifecycle.handleMentorApprovalReaction(reaction, { id: 'mentor' });
  assert.ok(!f.data.owner[0].mentorApproved);
  f.mentor.roles.cache.add('instructor');
  await lifecycle.handleMentorApprovalReaction(reaction, { id: 'other' });
  assert.ok(!f.data.owner[0].mentorApproved);
  await lifecycle.handleMentorApprovalReaction(reaction, { id: 'mentor' });
  assert.equal(f.data.owner[0].mentorApproved, true);
});

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

test('cleanup and create share a queue so a saved booking survives Discord deletion', async () => {
  const f = fixture({ owner: [booking('expired', { endUtc: '2026-10-20T04:00:00Z' })] });
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const reached = new Promise(r => { entered = r; });
  const lifecycle = createBookingLifecycle({ ...f.dependencies, fetchBookingMessage: async () => { entered(); await gate; return { delete: async () => {} }; } });
  const cleanup = lifecycle.cleanupExpiredBookings();
  await reached;
  const create = f.handlers.handlePlan(f.interaction);
  await Promise.resolve();
  assert.equal(f.posts.length, 0);
  release();
  await Promise.all([cleanup, create]);
  assert.equal(f.data.owner.length, 1);
  assert.equal(f.data.owner[0].messageId, 'new-1');
});

test('event relocation serializes with deletion and a stale menu cannot resurrect the booking', async () => {
  const f = fixture({ owner: [booking('A')] });
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const reached = new Promise(r => { entered = r; });
  const event = { uid: 'event', title: 'Test', startUtcISO: '2026-10-21T06:00:00Z', endUtcISO: '2026-10-21T08:00:00Z' };
  const service = createEventThreadService({ ...f.dependencies, ...f.dependencies.bookingLifecycle, rescheduleMentorTimers: noop });
  const move = service.moveBookingsIntoEventThread(event, { id: 'thread', guild: f.guild, send: async () => { entered(); await gate; return { id: 'moved' }; } });
  await reached;
  const deletion = f.handlers.handleDeleteBookingSelect({ ...f.interaction, values: ['owner|id:A'] });
  release(); await Promise.all([move, deletion]);
  assert.equal(f.data.owner[0].messageId, 'moved');
  await f.handlers.handleDeleteBookingSelect({ ...f.interaction, values: ['owner|id:moved'] });
  assert.deepEqual(f.data.owner, []);
});

test('a reminder in flight cannot overwrite a new booking for the same owner', async t => {
  const f = fixture({ owner: [booking('existing')] });
  let callback, release, entered;
  const gate = new Promise(r => { release = r; });
  const reached = new Promise(r => { entered = r; });
  t.mock.method(global, 'setTimeout', fn => { callback = fn; return {}; });
  t.mock.method(global, 'clearTimeout', noop);
  const lifecycle = createBookingLifecycle({ ...f.dependencies, client: { users: { fetch: async () => ({ send: async () => { entered(); await gate; } }) } } });
  lifecycle.scheduleBookingReminder('owner', f.data.owner[0]);
  callback();
  await reached;
  f.interaction.fields.getTextInputValue = key => ({ pos: 'NZAA_CTR', date: '22/10', start: '1900', end: '2100' })[key];
  const create = f.handlers.handlePlan(f.interaction);
  await Promise.resolve();
  assert.equal(f.posts.length, 0);
  release();
  await create;
  assert.equal(f.data.owner.length, 2);
  assert.ok(f.data.owner[0].reminderSentAt);
  assert.equal(f.data.owner[1].messageId, 'new-1');
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

test('a failed mutation releases the shared queue', async () => {
  const run = createBookingMutationQueue();
  await assert.rejects(run(async () => { throw new Error('failure'); }), /failure/);
  assert.equal(await run(async () => 42), 42);
});
