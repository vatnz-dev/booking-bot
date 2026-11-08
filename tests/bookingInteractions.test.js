const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime, NZ_ZONE } = require('../src/utils/time');

function stub(path, exports) {
  require.cache[require.resolve(path)] = { exports, loaded: true };
}
stub('../src/data/databases', { settings: { get: () => ({ enabled: false }) } });
stub('../src/services/positions', {
  validateVatnzPosition: async () => ({ valid: true, meta: { suffix: 'TWR' } }),
  validateVatnzEventPosition: async () => ({ valid: true }),
  evaluateBookingEligibility: () => ({ allowed: true })
});
stub('../src/services/vatsim', { getVatsimId: async () => '1234567' });
stub('../src/services/soloEndorsements', {
  getBookingStartNz: () => null,
  applySoloEndorsementOverride: async ({ baseEligibility }) => baseEligibility
});
const { createInteractionHandlers } = require('../src/handlers/interactions');
const date = DateTime.now().setZone(NZ_ZONE).plus({ days: 7 }).toFormat('dd/MM');
const messages = {
  all: () => [],
  get: () => [{ date, start: 1800, end: 2000, position: 'NZCH_APP' }],
  set: () => assert.fail('Conflicting bookings must not be saved')
};
const { handlePlan } = createInteractionHandlers({ messages, bookingLifecycle: {}, eventThreadService: {} });
function interaction() {
  return {
    user: { id: 'controller' },
    member: { user: { id: 'controller' }, roles: { cache: { has: () => false } } },
    isModalSubmit: () => true,
    deferReply: async () => {},
    fields: { getTextInputValue: key => ({ pos: 'NZAA_TWR', date, start: '1900', end: '2100' })[key] }
  };
}

test('booking handler rejects own overlapping session before posting or saving', async () => {
  let response;
  await handlePlan({ ...interaction(), editReply: async payload => { response = payload.content; } });
  assert.match(response, /already have a booking for NZCH_APP/);
});

test('simultaneous submissions are blocked and the guard releases on error', async () => {
  let rejectFirst;
  const first = handlePlan({ ...interaction(), deferReply: () => new Promise((_, reject) => { rejectFirst = reject; }) });
  let response;
  await handlePlan({ ...interaction(), reply: async payload => { response = payload.content; } });
  assert.match(response, /still being processed/);
  rejectFirst(new Error('test failure'));
  await assert.rejects(first, /test failure/);
  await handlePlan({ ...interaction(), editReply: async payload => { response = payload.content; } });
  assert.match(response, /already have a booking/);
});

const { createAccess } = require('../src/services/access');
const access = createAccess({
  settings: { get: () => undefined },
  env: { EVENT_POSITION_USER_IDS: 'events-director,events-manager', BOARD_ROLE_ID: 'board', SENIOR_STAFF_ROLE_ID: 'senior-staff' }
});
const member = (id, roles) => ({ id, user: { id }, roles: { cache: new Set(roles) } });

for (const action of ['Open', 'Close']) {
  test(`${action} event position refuses everyone else before any side effects, and logs it`, async () => {
    const cases = [
      [null, /don't have permission/],
      [member('ops', ['ops-staff', 'senior-staff']), /don't have permission/],
      [member('events-manager', ['events-team']), /access to this action has lapsed/]
    ];
    for (const [who, message] of cases) {
      const audits = [];
      const handlers = createInteractionHandlers({ access, sendAuditLog: async entry => audits.push(entry), bookingLifecycle: {}, eventThreadService: {} });
      let response;
      await handlers[`handle${action}EventPosition`]({
        member: who,
        commandName: `${action.toLowerCase()}eventposition`,
        reply: async payload => { response = payload; },
        deferReply: () => assert.fail('Unauthorized interaction must not be deferred'),
        options: { getString: () => assert.fail('Unauthorized interaction must not read options') }
      });
      assert.equal(response.ephemeral, true);
      assert.match(response.content, message);
      assert.equal(audits[0].action, 'Action Refused');
    }
  });

  test(`${action} event position permits each named user while they hold Board or Senior Staff`, async () => {
    for (const who of [member('events-director', ['board']), member('events-manager', ['senior-staff', 'events-team'])]) {
      // Close starts with the date open; Open starts with nothing open.
      const store = initial => { const map = new Map(Object.entries(initial)); return { map, get: k => map.get(k), set: (k, v) => map.set(k, v) }; };
      const event = store(action === 'Close' ? { 'NZAA-R_CTR': ['2099-10-25'] } : {});
      const eventclose = store(action === 'Close' ? { 'NZAA-R_CTR': { '2099-10-25': 'message' } } : {});
      const audits = [];
      let posted = 0;
      let deleted = 0;
      const channel = {
        id: 'channel',
        send: async () => { posted++; return { id: 'message', guild: { id: 'guild' } }; },
        messages: { fetch: async () => ({ delete: async () => { deleted++; } }) }
      };
      const handlers = createInteractionHandlers({
        access,
        event,
        eventclose,
        getBookingChannel: async () => channel,
        sendAuditLog: async entry => audits.push(entry),
        bookingLifecycle: {}, eventThreadService: {}
      });
      let response;
      await handlers[`handle${action}EventPosition`]({
        member: who,
        user: { id: who.id },
        options: { getString: key => key === 'position' ? 'NZAA-R_CTR' : '25/10/2099' },
        deferReply: async () => {},
        editReply: async payload => { response = payload.content; }
      });
      assert.deepEqual(event.map.get('NZAA-R_CTR'), action === 'Open' ? ['2099-10-25'] : []);
      assert.match(response, action === 'Open' ? /opened for 25 Oct 2099/ : /closed for 25 Oct 2099/);
      assert.equal(audits.length, 1);
      assert.equal(posted, action === 'Open' ? 1 : 0);
      assert.equal(deleted, action === 'Close' ? 1 : 0);
    }
  });
}

test('a position can be open for several dates, and closing one date keeps the others', async () => {
  const store = () => { const map = new Map(); return { map, get: k => map.get(k), set: (k, v) => map.set(k, v) }; };
  const event = store();
  const eventclose = store();
  const deleted = [];
  let posts = 0;
  const audits = [];
  const handlers = createInteractionHandlers({
    access, event, eventclose,
    getBookingChannel: async () => ({
      id: 'channel',
      send: async () => ({ id: `post-${++posts}`, guild: { id: 'guild' } }),
      messages: { fetch: async id => ({ delete: async () => deleted.push(id) }) }
    }),
    sendAuditLog: async entry => audits.push(entry),
    bookingLifecycle: {}, eventThreadService: {}
  });
  const run = async (action, date) => {
    let response;
    await handlers[`handle${action}EventPosition`]({
      member: member('events-director', ['board']), user: { id: 'events-director' },
      options: { getString: key => (key === 'position' ? 'NZAA_DEP' : date) },
      deferReply: async () => {}, editReply: async payload => { response = payload.content; }
    });
    return response;
  };

  await run('Open', '15/11/2099');
  await run('Open', '29/11/2099');
  assert.match(await run('Open', '29/11/2099'), /already open on 29 Nov 2099/);
  assert.deepEqual(event.map.get('NZAA_DEP'), ['2099-11-15', '2099-11-29']);
  assert.equal(posts, 2);

  assert.match(await run('Close', '15/11'), /closed for 15 Nov 2099/);
  assert.deepEqual(event.map.get('NZAA_DEP'), ['2099-11-29']);
  assert.deepEqual(eventclose.map.get('NZAA_DEP'), { '2099-11-29': 'post-2' });
  assert.deepEqual(deleted, ['post-1']);
  assert.match(await run('Close', '01/12'), /isn't open on 01\/12/);
  assert.deepEqual(audits.map(a => a.action), ['Event Position Opened', 'Event Position Opened', 'Event Position Closed']);
});
