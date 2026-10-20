const { test } = require('node:test');
process.env.S1_ROLE_ID = 'student';
process.env.I1_ROLE_ID = 'instructor';
const assert = require('node:assert/strict');
const { DateTime, NZ_ZONE, convertToUTC } = require('../src/utils/time');
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports, loaded: true }; };
const date = DateTime.now().setZone(NZ_ZONE).plus({ days: 7 }).toFormat('dd/MM');
let validation, eligibility, validateHook, trafficCalls;
stub('../src/services/positions', {
  validateVatnzPosition: async () => { if (validateHook) await validateHook(); return validation; },
  evaluateBookingEligibility: () => eligibility
});
stub('../src/services/vatsim', { getVatsimId: async () => '1234567' });
stub('../src/services/soloEndorsements', {
  getBookingStartNz: () => null,
  applySoloEndorsementOverride: async ({ baseEligibility }) => baseEligibility,
  buildSoloNotice: () => 'Current solo endorsement', formatEndorsementScope: () => 'Tower'
});
stub('../src/services/traffic', {
  formatSectorTraffic: async (...args) => { trafficCalls.push(args); return 'Updated sector traffic'; },
  formatAerodromeTraffic: async (...args) => { trafficCalls.push(args); return 'Updated aerodrome traffic'; }
});
const { createInteractionHandlers } = require('../src/handlers/interactions');

function fixture({ others = {}, staff = false, owner = 'owner' } = {}) {
  validation = { valid: true, meta: { suffix: 'TWR' } };
  eligibility = { allowed: true, mentorRequired: false };
  validateHook = null;
  trafficCalls = [];
  const initial = { messageId: 'old', position: 'NZCH_TWR', date, start: 1800, end: 2000, channelId: 'general', extendedSectors: [], mentorApproved: true, reminderSentAt: 'old-reminder', createdAt: '2026-01-01T00:00:00Z' };
  const data = { [owner]: [initial], ...others };
  const calls = [], replies = [], posts = [], audits = [];
  const member = { user: { id: owner, displayAvatarURL: () => 'https://example.com/avatar.png' }, roles: { cache: new Set() } };
  const channel = { id: 'general', guild: { id: 'guild' }, send: async payload => {
    posts.push(payload);
    return { id: `new-${posts.length}`, delete: async () => calls.push('delete-new') };
  } };
  const messages = {
    get: id => structuredClone(data[id]),
    all: () => Object.entries(data).map(([key, value]) => ({ key, data: structuredClone(value) })),
    set: (id, value) => { data[id] = structuredClone(value); calls.push('save'); }
  };
  const dependencies = {
    messages, event: { get: () => '0/0' }, client: { users: { fetch: async () => ({ send: async payload => calls.push(['owner-dm', payload]) }) } }, isStaffMember: () => staff,
    getBookingChannel: async () => channel,
    fetchBookingMessage: async () => ({ delete: async () => calls.push('delete-old') }),
    sendAuditLog: async entry => audits.push(entry),
    eventThreadService: {
      findMatchingEventThreadForBooking: async () => null,
      refreshEventCoverageNotificationsForBooking: async b => calls.push(`coverage:${b.messageId}`)
    },
    bookingLifecycle: Object.fromEntries(['clearMentorTimers', 'clearExtensionSelectionTimer', 'clearBookingReminderTimer', 'scheduleBookingReminder', 'scheduleMentorTagTimeout'].map(name => [name, (...args) => calls.push([name, ...args])]))
  };
  const handlers = createInteractionHandlers(dependencies);
  const interaction = {
    user: { id: staff ? 'staff' : owner }, member,
    guild: { members: { fetch: async id => { calls.push(`member:${id}`); return member; } } },
    options: { getUser: () => owner === 'owner' && !staff ? null : { id: owner } },
    reply: async payload => replies.push(payload), editReply: async payload => replies.push(payload),
    deferReply: async () => {}, followUp: async payload => replies.push(payload),
    showModal: async modal => { interaction.modal = modal.toJSON(); }
  };
  async function open() {
    await handlers.handleEditBookings(interaction);
    const token = replies.at(-1).components[0].toJSON().components[0].options[0].value;
    interaction.values = [token];
    await handlers.handleEditBookingSelect(interaction);
    interaction.customId = interaction.modal.custom_id;
  }
  async function submit(values = {}) {
    interaction.fields = { getTextInputValue: key => ({ pos: 'NZAA_TWR', date, start: '1900', end: '2100', sectors: '', ...values })[key] };
    await handlers.handleEditBookingSubmit(interaction);
  }
  return { handlers, dependencies, interaction, data, messages, calls, posts, audits, replies, channel, open, submit };
}

test('picker opens a prefilled form and a valid edit replaces post, timers and traffic', async () => {
  const f = fixture();
  await f.open();
  assert.equal(f.interaction.modal.components.length, 5);
  assert.equal(f.interaction.modal.components[2].components[0].value, '1800');
  await f.submit();
  const saved = f.data.owner[0];
  assert.equal(saved.position, 'NZAA_TWR');
  assert.equal(saved.messageId, 'new-1');
  assert.equal(saved.startUtc, convertToUTC(date, '1900'));
  assert.equal(saved.mentorApproved, false);
  assert.equal(saved.reminderSentAt, null);
  assert.ok(f.calls.indexOf('save') < f.calls.indexOf('delete-old'));
  assert.ok(f.calls.some(c => Array.isArray(c) && c[0] === 'scheduleBookingReminder'));
  assert.deepEqual(trafficCalls[0].slice(2), ['1900', '2100']);
  assert.equal(f.audits[0].action, 'Booking Edited');
});

test('selection uses stable identity when a preceding booking is deleted', async () => {
  const f = fixture();
  f.data.owner.unshift({ ...f.data.owner[0], messageId: 'preceding', start: 1400, end: 1500 });
  await f.handlers.handleEditBookings(f.interaction);
  const options = f.replies[0].components[0].toJSON().components[0].options;
  f.data.owner.shift();
  await f.handlers.handleEditBookingSelect({ ...f.interaction, values: [options[1].value] });
  assert.equal(f.interaction.modal.components[2].components[0].value, '1800');
});

for (const [name, other, values, pattern] of [
  ['own overlapping position', { position: 'NZWN_APP' }, {}, /already have an overlapping/],
  ['taken main position', { position: 'NZAA_TWR' }, {}, /already booked or extended/],
  ['main position in someone else\'s extensions', { position: 'NZCH-S_CTR', extendedSectors: ['NZAA_CTR'] }, { pos: 'NZAA_CTR' }, /NZAA_CTR is already/],
  ['inherited sector taken as a main position', { position: 'NZCH-B_CTR' }, { pos: 'NZAA_CTR' }, /NZCH-B_CTR is already/],
  ['optional sector taken', { position: 'NZCH-T_CTR' }, { pos: 'NZAA_CTR', sectors: 'NAK' }, /NZCH-T_CTR is already/]
]) {
  test(`edit rejects ${name} without changing original`, async () => {
    const f = fixture();
    f.data[name.startsWith('own') ? 'owner' : 'other'] ||= [];
    f.data[name.startsWith('own') ? 'owner' : 'other'].push({ messageId: 'other', date, start: 2000, end: 2200, ...other });
    const before = structuredClone(f.data);
    await f.open(); await f.submit(values);
    assert.match(f.replies.at(-1).content, pattern);
    assert.deepEqual(f.data, before);
    assert.equal(f.posts.length, 0);
  });
}

test('back-to-back booking is allowed and the edited booking excludes itself', async () => {
  const f = fixture();
  f.data.other = [{ messageId: 'other', position: 'NZAA_TWR', date, start: 2100, end: 2300 }];
  await f.open(); await f.submit();
  assert.equal(f.posts.length, 1);
});

test('sectors accept codes, deduplicate, add inheritance and refresh all sector traffic', async () => {
  const f = fixture(); await f.open();
  await f.submit({ pos: 'NZAA_CTR', sectors: 'NAK, NZCH-T_CTR' });
  assert.deepEqual(f.data.owner[0].extendedSectors, ['NZCH-B_CTR', 'NZCH-T_CTR']);
  assert.deepEqual(trafficCalls[0][0], ['NZAA_CTR', 'NZCH-B_CTR', 'NZCH-T_CTR']);
});

test('clearing extra sectors removes old extras but keeps inherited sectors', async () => {
  const f = fixture();
  Object.assign(f.data.owner[0], { position: 'NZAA_CTR', extendedSectors: ['NZCH-B_CTR', 'NZCH-T_CTR'] });
  await f.open(); await f.submit({ pos: 'NZAA_CTR' });
  assert.deepEqual(f.data.owner[0].extendedSectors, ['NZCH-B_CTR']);
});

for (const values of [{ date: '31/02' }, { start: '2460' }, { start: '900' }, { end: '1800' }, { end: '1915' }, { sectors: 'NAK' }, { pos: 'NZAA_CTR', sectors: 'FAKE' }]) {
  test(`invalid edit stays unchanged: ${JSON.stringify(values)}`, async () => {
    const f = fixture(); const before = structuredClone(f.data);
    await f.open(); await f.submit(values);
    assert.equal(f.posts.length, 0);
    assert.deepEqual(f.data, before);
  });
}

test('stale forms and replayed submissions cannot overwrite bookings', async () => {
  const f = fixture(); await f.open();
  f.data.owner[0].mentorApproved = false;
  await f.submit();
  assert.match(f.replies.at(-1).content, /changed/);
  assert.equal(f.posts.length, 0);
  await f.open(); await f.submit(); await f.submit();
  assert.equal(f.posts.length, 1);
});

test('non-staff cannot target another controller or use another user\'s selection', async () => {
  const f = fixture(); f.interaction.options.getUser = () => ({ id: 'someone-else' });
  await f.handlers.handleEditBookings(f.interaction);
  assert.match(f.replies.at(-1).content, /only edit your own/);
  f.interaction.options.getUser = () => null;
  await f.open();
  await f.handlers.handleEditBookingSelect({ ...f.interaction, user: { id: 'intruder' } });
  assert.match(f.replies.at(-1).content, /changed or the selection expired/);
});

test('staff editing uses the controller\'s eligibility and records the staff actor', async () => {
  const f = fixture({ staff: true }); await f.open();
  eligibility = { allowed: false, reason: 'Controller is not rated for this position' };
  await f.submit();
  assert.equal(f.posts.length, 0);
  assert.match(f.replies.at(-1).content, /not rated/);
  eligibility = { allowed: true, mentorRequired: true };
  await f.submit();
  assert.ok(f.calls.includes('member:owner'));
  assert.equal(f.audits[0].actorId, 'staff');
  assert.ok(f.data.owner[0].mentorTagRequestedAt);
  assert.ok(f.calls.some(c => Array.isArray(c) && c[0] === 'scheduleMentorTagTimeout'));
  assert.ok(f.calls.some(c => Array.isArray(c) && c[0] === 'owner-dm' && /within 5 minutes/.test(c[1].content)));
});

test('event-only position checks and routing are refreshed', async () => {
  const f = fixture(); await f.open();
  validation.meta.isEvent = true;
  await f.submit(); assert.equal(f.posts.length, 0);
  f.dependencies.event.get = () => date;
  const thread = { ...f.channel, id: 'event-thread' };
  f.dependencies.eventThreadService.findMatchingEventThreadForBooking = async () => ({ thread, state: { event: { title: 'Test Event', uid: 'event-uid' } } });
  // Factories capture the service functions, so recreate handlers and picker.
  f.handlers = createInteractionHandlers(f.dependencies);
  await f.handlers.handleEditBookings(f.interaction);
  f.interaction.values = [f.replies.at(-1).components[0].toJSON().components[0].options[0].value];
  await f.handlers.handleEditBookingSelect(f.interaction);
  f.interaction.customId = f.interaction.modal.custom_id;
  await f.handlers.handleEditBookingSubmit(f.interaction);
  assert.equal(f.data.owner[0].threadId, 'event-thread');
  assert.equal(f.data.owner[0].eventName, 'Test Event');
});

test('failed Discord send preserves original booking and releases mutation queue', async () => {
  const f = fixture(); await f.open();
  const before = structuredClone(f.data);
  const send = f.channel.send;
  f.channel.send = async () => { throw new Error('Discord unavailable'); };
  await assert.rejects(f.submit(), /Discord unavailable/);
  assert.deepEqual(f.data, before);
  assert.ok(!f.calls.includes('delete-old'));
  f.channel.send = send; await f.submit();
  assert.equal(f.posts.length, 1);
});

test('save failure removes the replacement message and preserves original', async () => {
  const f = fixture(); await f.open();
  const before = structuredClone(f.data);
  f.messages.set = () => { throw new Error('disk full'); };
  await assert.rejects(f.submit(), /disk full/);
  assert.deepEqual(f.data, before);
  assert.ok(f.calls.includes('delete-new'));
  assert.ok(!f.calls.includes('delete-old'));
});

test('concurrent edits for the same sector serialize and only one succeeds', async () => {
  const f = fixture();
  f.data.other = [{ ...f.data.owner[0], messageId: 'other-old', position: 'NZWN_TWR' }];
  await f.open();
  const other = { ...f.interaction, user: { id: 'other' }, member: { ...f.interaction.member, user: { ...f.interaction.member.user, id: 'other' } }, options: { getUser: () => null } };
  await f.handlers.handleEditBookings(other);
  const token = f.replies.at(-1).components[0].toJSON().components[0].options[0].value;
  let modal;
  await f.handlers.handleEditBookingSelect({ ...other, values: [token], showModal: async value => { modal = value.toJSON(); } });
  await Promise.all([f.submit(), f.handlers.handleEditBookingSubmit({ ...other, customId: modal.custom_id, fields: { getTextInputValue: key => ({ pos: 'NZAA_TWR', date, start: '1900', end: '2100', sectors: '' })[key] } })]);
  assert.equal(f.posts.length, 1);
  assert.match(f.replies.at(-1).content, /already booked or extended/);
});

test('a new booking racing an edit sees its committed position', async () => {
  const f = fixture(); await f.open();
  const other = { ...f.interaction, user: { id: 'other' }, member: { ...f.interaction.member, user: { ...f.interaction.member.user, id: 'other' } }, isModalSubmit: () => true,
    fields: { getTextInputValue: key => ({ pos: 'NZAA_TWR', date, start: '1900', end: '2100' })[key] } };
  await Promise.all([f.submit(), f.handlers.handlePlan(other)]);
  assert.equal(f.posts.length, 1);
  assert.match(f.replies.at(-1).content, /already booked/);
});

test('editing an active booking preserves its year and uses its actual previous week', async t => {
  const { Settings } = require('luxon');
  const originalNow = Settings.now;
  const midday = DateTime.now().setZone(NZ_ZONE).set({ hour: 12, minute: 0 }).toMillis();
  Settings.now = () => midday;
  t.after(() => { Settings.now = originalNow; });
  const f = fixture();
  const nowNz = DateTime.now().setZone(NZ_ZONE);
  const today = nowNz.toFormat('dd/MM');
  const year = nowNz.year;
  const local = time => DateTime.fromFormat(`${year} ${today} ${time}`, 'yyyy dd/MM HHmm', { zone: NZ_ZONE });
  Object.assign(f.data.owner[0], { date: today, start: 0, end: 2300, startUtc: local('0000').toUTC().toISO(), endUtc: local('2300').toUTC().toISO() });
  await f.open(); await f.submit({ date: today, start: '0000', end: '2300' });
  assert.equal(DateTime.fromISO(f.data.owner[0].startUtc).setZone(NZ_ZONE).year, year);
  assert.equal(trafficCalls[0][1], local('0000').minus({ days: 7 }).toFormat('yyyy-MM-dd'));
});

test('stored UTC overlap is checked even if legacy date labels differ', async () => {
  const f = fixture();
  f.data.other = [{ messageId: 'other', position: 'NZAA_TWR', date: '01/01', start: 100, end: 200, startUtc: convertToUTC(date, '2000'), endUtc: convertToUTC(date, '2200') }];
  await f.open(); await f.submit();
  assert.equal(f.posts.length, 0);
  assert.match(f.replies.at(-1).content, /already booked/);
});

test('booking changed during directory lookup cannot be overwritten', async () => {
  const f = fixture(); await f.open();
  validateHook = async () => { f.data.owner[0].mentorId = 'new-mentor'; };
  await f.submit();
  assert.equal(f.posts.length, 0);
  assert.match(f.replies.at(-1).content, /changed while being checked/);
});

test('notification failures leave a successful saved edit and traffic reply', async () => {
  const f = fixture();
  f.dependencies.eventThreadService.refreshEventCoverageNotificationsForBooking = async () => { throw new Error('coverage unavailable'); };
  const handlers = createInteractionHandlers(f.dependencies);
  await handlers.handleEditBookings(f.interaction);
  const token = f.replies.at(-1).components[0].toJSON().components[0].options[0].value;
  await handlers.handleEditBookingSelect({ ...f.interaction, values: [token] });
  await handlers.handleEditBookingSubmit({ ...f.interaction, customId: f.interaction.modal.custom_id, fields: { getTextInputValue: key => ({ pos: 'NZAA_TWR', date, start: '1900', end: '2100', sectors: '' })[key] } });
  assert.equal(f.data.owner[0].messageId, 'new-1');
  assert.ok(f.replies.some(p => /Booking updated/.test(p.content)));
  assert.match(f.replies.at(-1).content, /Updated aerodrome traffic/);
});

test('an edit queued during cleanup survives the cleanup write', async () => {
  const { createBookingMutationQueue } = require('../src/utils/bookingMutations');
  const { createBookingLifecycle } = require('../src/services/bookingLifecycle');
  const f = fixture();
  f.dependencies.runBookingMutation = createBookingMutationQueue();
  f.handlers = createInteractionHandlers(f.dependencies);
  await f.open();
  f.data.owner.unshift({ messageId: 'expired', endUtc: DateTime.now().minus({ hours: 1 }).toUTC().toISO() });
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const reached = new Promise(r => { entered = r; });
  const lifecycle = createBookingLifecycle({ ...f.dependencies, fetchBookingMessage: async () => { entered(); await gate; return null; } });
  const cleanup = lifecycle.cleanupExpiredBookings();
  await reached;
  const edit = f.submit();
  await Promise.resolve();
  assert.equal(f.posts.length, 0);
  release(); await Promise.all([cleanup, edit]);
  assert.equal(f.data.owner.length, 1);
  assert.equal(f.data.owner[0].messageId, 'new-1');
  assert.equal(f.data.owner[0].position, 'NZAA_TWR');
});


test('edited booking embed displays I1 when the controller also holds S1', async () => {
  const f = fixture();
  f.interaction.member.roles.cache = new Set(['student', 'instructor']);
  await f.open(); await f.submit();
  assert.equal(f.posts[0].embeds[0].toJSON().footer.text, 'I1 - Instructor');
});
