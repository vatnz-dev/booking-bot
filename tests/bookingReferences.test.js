const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.TRAINING_TEAM_ROLE_ID = 'training';

const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports, loaded: true }; };
stub('../src/data/databases', { settings: { get: () => ({ enabled: false }) } });
const { createInteractionHandlers } = require('../src/handlers/interactions');
const { createBookingLifecycle } = require('../src/services/bookingLifecycle');
const { createEventThreadService } = require('../src/services/eventThreads');
const { runBookingMutation } = require('../src/services/bookingQueue');

// Like the real JSON database: every read is a fresh copy, so a stale copy saved later overwrites newer changes.
function store(initial = {}) {
  const data = new Map(Object.entries(initial));
  const copy = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  return {
    data,
    get: key => copy(data.get(key)),
    set: (key, value) => data.set(key, copy(value)),
    all: () => [...data].map(([key, value]) => ({ key, data: copy(value) }))
  };
}

const booking = (messageId, position, date, extra = {}) => ({ messageId, position, date, start: 1800, end: 2000, ...extra });
const sam = () => [booking('m-aa', 'NZAA_TWR', '12/11'), booking('m-ch', 'NZCH_GND', '14/11')];
const staff = { id: 'staff', user: { id: 'staff' }, roles: { cache: new Set(['events-team']) } };
const samMember = { id: 'sam', user: { id: 'sam' }, roles: { cache: new Set() } };

function handlers(messages, audits = []) {
  return createInteractionHandlers({
    messages,
    access: { can: (permission, member) => (member.roles.cache.has('events-team') ? 'ok' : 'denied') },
    sendAuditLog: async entry => audits.push(entry),
    fetchBookingMessage: async () => null,
    bookingLifecycle: { clearMentorTimers: () => {}, clearExtensionSelectionTimer: () => {}, clearBookingReminderTimer: () => {} },
    eventThreadService: { refreshEventCoverageNotificationsForBooking: async () => {} }
  });
}

// Opens /deletebookings and returns its menu options and page buttons.
async function openDeleteMenu(h, member, controller) {
  let reply;
  await h.handleDeleteBookings({
    member, user: member.user,
    options: { getUser: () => controller ?? null },
    reply: async payload => { reply = payload; }
  });
  return reply.components.map(row => row.toJSON().components);
}

async function choose(h, member, value, handler = 'handleDeleteBookingSelect') {
  let reply;
  await h[handler]({
    member, user: member.user, values: [value], guild: null,
    deferUpdate: async () => {}, editReply: async payload => { reply = payload; }
  });
  return reply?.content;
}

test('an old menu still deletes the booking it shows, and refuses one that is gone', async () => {
  const messages = store({ sam: sam() });
  const h = handlers(messages);
  const [first] = await openDeleteMenu(h, samMember);
  const [second] = await openDeleteMenu(h, samMember);
  const value = (menu, position) => menu[0].options.find(o => o.label.startsWith(position)).value;

  await choose(h, samMember, value(first, 'NZAA_TWR'));
  assert.match(await choose(h, samMember, value(second, 'NZAA_TWR')), /That booking no longer exists/);
  assert.deepEqual(messages.data.get('sam').map(b => b.position), ['NZCH_GND'], 'no other booking is changed');

  assert.match(await choose(h, samMember, value(second, 'NZCH_GND')), /NZCH_GND/);
  assert.deepEqual(messages.data.get('sam'), []);
});

test('a staff member deletes the booking they chose after the controller list changed', async () => {
  const messages = store({ sam: sam() });
  const h = handlers(messages);
  const [staffMenu] = await openDeleteMenu(h, staff, { id: 'sam' });
  const [samMenu] = await openDeleteMenu(h, samMember);
  await choose(h, samMember, samMenu[0].options[0].value);

  await choose(h, staff, staffMenu[0].options.find(o => o.label.startsWith('NZCH_GND')).value);
  assert.deepEqual(messages.data.get('sam'), []);
});

test('a booking moved into an event thread is still found by an older menu', async () => {
  const messages = store({ sam: [booking('m-new', 'NZCH_GND', '14/11', { previousMessageIds: ['m-ch'] })] });
  const h = handlers(messages);
  assert.match(await choose(h, samMember, 'sam|m-ch'), /NZCH_GND/);
  assert.deepEqual(messages.data.get('sam'), []);
});

test('menus page past 25 bookings', async () => {
  const thirty = Array.from({ length: 30 }, (_, i) => booking(`m-${i}`, `NZAA_TWR`, `${String(i + 1).padStart(2, '0')}/12`));
  const messages = store({ sam: thirty });
  const h = handlers(messages);
  const [menu, buttons] = await openDeleteMenu(h, samMember);
  assert.equal(menu[0].options.length, 25);
  assert.equal(buttons[0].disabled, true, 'Previous is disabled on the first page');

  let update;
  await h.handleBookingMenuPage({ customId: buttons[1].custom_id, user: samMember.user, member: samMember, update: async payload => { update = payload; } });
  const [page2, page2Buttons] = update.components.map(row => row.toJSON().components);
  assert.equal(page2[0].options.length, 5);
  assert.equal(page2Buttons[1].disabled, true, 'Next is disabled on the last page');
  assert.equal(page2[0].options[0].value, 'sam|m-25');

  // Paging someone else's bookings needs the same permission as deleting them.
  let refused;
  await h.handleBookingMenuPage({ customId: 'delete_booking_page:other:1', user: samMember.user, member: samMember, reply: async payload => { refused = payload; } });
  assert.match(refused.content, /only delete your own/);

  let mentorReply;
  await h.handleMentor({
    member: { ...samMember, user: { id: 'sam' } }, user: { id: 'sam' },
    options: { getMember: () => ({ id: 'morgan', user: { id: 'morgan', username: 'Morgan', bot: false }, roles: { cache: new Set(['training']) } }) },
    reply: async payload => { mentorReply = payload; }
  });
  const [mentorMenu, mentorButtons] = mentorReply.components.map(row => row.toJSON().components);
  assert.equal(mentorMenu[0].options.length, 25);
  assert.equal(mentorMenu[0].options[0].value, 'm-0|morgan');
  assert.match(mentorButtons[1].custom_id, /^mentor_booking_page:morgan:1$/);
});

test('an event-thread move and a user edit to the same booking both survive', async () => {
  const messages = store({ sam: [booking('m-ch', 'NZCH_GND', '14/11', { startUtc: '2099-11-14T05:00:00Z', endUtc: '2099-11-14T07:00:00Z' })] });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = createEventThreadService({
    eventThreads: store(), messages, sendAuditLog: async () => {},
    fetchBookingMessage: async () => { await gate; return null; },
    clearMentorTimers: () => {}, clearExtensionSelectionTimer: () => {}, rescheduleMentorTimers: () => {},
    access: { mentions: () => [] }
  });
  const thread = { id: 'thread', guild: { id: 'guild' }, send: async () => ({ id: 'm-thread', react: async () => {} }) };
  const eventData = { uid: 'e', title: 'Christchurch Control', startUtcISO: '2099-11-14T04:00:00Z', endUtcISO: '2099-11-14T08:00:00Z' };

  const move = service.moveBookingsIntoEventThread(eventData, thread);
  const edit = runBookingMutation(() => {
    const bookings = messages.get('sam');
    bookings[0].end = 2100;
    messages.set('sam', bookings);
  });
  release();
  await Promise.all([move, edit]);

  const [saved] = messages.data.get('sam');
  assert.equal(saved.end, 2100, "Sam's edit is kept");
  assert.equal(saved.threadId, 'thread', 'the booking ends up in the event thread');
});

test('a booking made while the hourly cleanup runs is not lost', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const messages = store({ sam: [booking('m-old', 'NZAA_TWR', '01/01', { endUtc: '2020-01-01T07:00:00Z' })] });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const lifecycle = createBookingLifecycle({
    client: {}, messages, sendAuditLog: async () => {},
    fetchBookingMessage: async () => { await gate; return null; }
  });
  lifecycle.startBookingCleanupScheduler();
  const add = runBookingMutation(() => {
    const bookings = messages.get('sam');
    bookings.push(booking('m-new', 'NZCH_TWR', '01/12', { endUtc: '2099-12-01T07:00:00Z' }));
    messages.set('sam', bookings);
  });
  release();
  await add;
  assert.deepEqual(messages.data.get('sam').map(b => b.messageId), ['m-new']);
});
