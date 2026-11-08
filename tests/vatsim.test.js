const { test } = require('node:test');
const assert = require('node:assert/strict');

const requests = [];
let reply = async () => ({ data: { user_id: 1234567 } });
require.cache[require.resolve('../src/utils/http')] = {
  loaded: true,
  exports: { get: async url => { requests.push(url); return reply(); } }
};
const { getVatsimId } = require('../src/services/vatsim');

test('found VATSIM IDs are cached for 12 hours; misses are not cached', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.method(console, 'log', () => {});
  assert.equal(await getVatsimId('sam'), 1234567);
  t.mock.timers.tick(11 * 60 * 60 * 1000);
  assert.equal(await getVatsimId('sam'), 1234567);
  assert.equal(requests.length, 1);
  t.mock.timers.tick(2 * 60 * 60 * 1000);
  await getVatsimId('sam');
  assert.equal(requests.length, 2);

  reply = async () => ({ data: {} });
  assert.equal(await getVatsimId('unlinked'), null);
  assert.equal(await getVatsimId('unlinked'), null);
  assert.equal(requests.length, 4);
});
