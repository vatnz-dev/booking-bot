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

const { hasStaffRole } = require('../src/utils/permissions');
const staffRoles = ['senior-staff', 'ops-staff', 'board'];

for (const action of ['Open', 'Close']) {
  test(`${action} event position denies non-staff before any side effects`, async () => {
    const handlers = createInteractionHandlers({
      isStaffMember: member => hasStaffRole(member, staffRoles),
      bookingLifecycle: {}, eventThreadService: {}
    });
    for (const member of [null, { roles: ['controller'] }]) {
      let response;
      await handlers[`handle${action}EventPosition`]({
        member,
        reply: async payload => { response = payload; },
        deferReply: () => assert.fail('Unauthorized interaction must not be deferred'),
        options: { getString: () => assert.fail('Unauthorized interaction must not read options') }
      });
      assert.equal(response.ephemeral, true);
      assert.match(response.content, /Only staff/);
    }
  });

  test(`${action} event position permits each configured staff role`, async () => {
    for (const role of staffRoles) {
      const saved = [];
      const audits = [];
      let posted = 0;
      let deleted = 0;
      const channel = {
        id: 'channel',
        send: async () => { posted++; return { id: 'message', guild: { id: 'guild' } }; },
        messages: { fetch: async () => ({ delete: async () => { deleted++; } }) }
      };
      const handlers = createInteractionHandlers({
        isStaffMember: member => hasStaffRole(member, staffRoles),
        event: { set: (...args) => saved.push(args) },
        eventclose: { set: () => {}, get: () => 'message' },
        getBookingChannel: async () => channel,
        sendAuditLog: async entry => audits.push(entry),
        bookingLifecycle: {}, eventThreadService: {}
      });
      let response;
      await handlers[`handle${action}EventPosition`]({
        member: { roles: { cache: new Set([role]) } },
        user: { id: 'staff' },
        options: { getString: key => key === 'position' ? 'NZAA-R_CTR' : '25/10' },
        deferReply: async () => {},
        editReply: async payload => { response = payload.content; }
      });
      assert.deepEqual(saved, [['NZAA-R_CTR', action === 'Open' ? '25/10' : '0/0']]);
      assert.match(response, action === 'Open' ? /opened!/ : /closed!/);
      assert.equal(audits.length, 1);
      assert.equal(posted, action === 'Open' ? 1 : 0);
      assert.equal(deleted, action === 'Close' ? 1 : 0);
    }
  });
}
