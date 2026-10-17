const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime, NZ_ZONE } = require('../src/utils/time');

function stub(path, exports) {
  require.cache[require.resolve(path)] = { exports, loaded: true };
}
stub('../src/data/databases', { settings: { get: () => ({ enabled: false }) } });
stub('../src/services/positions', {
  validateVatnzPosition: async () => ({ valid: true, meta: { suffix: 'TWR' } }),
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
