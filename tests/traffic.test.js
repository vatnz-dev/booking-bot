const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

// Keep outage simulations isolated from the bot's real persisted settings.
let stored;
require.cache[require.resolve('../src/data/databases')] = {
  loaded: true,
  exports: { settings: { get: () => stored, set: (_, value) => { stored = value; } } }
};
const traffic = require('../src/services/traffic');
const healthy = '<body>Departures: 48 Arrivals: 73</body>';

test('StatSim outages, recovery, zero counts and staff overrides', async () => {
  traffic.setStatsimEnabled(true);
  axios.get = async () => ({ data: healthy });
  const data = await traffic.getTrafficData('NZAA', '2026-10-10');
  assert.equal(data.departures, 48);
  assert.equal(data.arrivals, 73);

  axios.get = async () => { throw new Error('HTTP 503'); };
  assert.equal(await traffic.formatAerodromeTraffic('NZCH_TWR', '2026-10-10'), traffic.STATSIM_DISABLED_MESSAGE);
  assert.equal(traffic.getStatsimState().autoDisabled, true);
  assert.equal(await traffic.checkStatsimHealth(), false);
  assert.equal(traffic.getStatsimState().enabled, false);

  // A valid quiet airport/day is healthy and must permit recovery.
  axios.get = async () => ({ data: '<body>Departures: 0 Arrivals: 0</body>' });
  assert.equal(await traffic.checkStatsimHealth(), true);
  assert.equal(traffic.getStatsimState().enabled, true);
  assert.equal(traffic.getStatsimState().autoDisabled, false);

  axios.get = async () => ({ data: '<body>Service unavailable</body>' });
  assert.equal(await traffic.checkStatsimHealth(), false);
  assert.equal(traffic.getStatsimState().autoDisabled, true);

  let requests = 0;
  axios.get = async () => { requests++; return { data: healthy }; };
  traffic.setStatsimEnabled(false, { actorId: 'staff' });
  await traffic.checkStatsimHealth();
  assert.equal(await traffic.formatSectorTraffic(['NZAA_CTR'], '2026-10-10'), traffic.STATSIM_DISABLED_MESSAGE);
  assert.equal(requests, 0);

  traffic.setStatsimEnabled(true);
  let finish;
  axios.get = () => new Promise(resolve => { finish = resolve; });
  const check = traffic.checkStatsimHealth();
  traffic.setStatsimEnabled(false, { actorId: 'staff' });
  finish({ data: healthy });
  await check;
  assert.equal(traffic.getStatsimState().enabled, false);
  assert.equal(traffic.getStatsimState().autoDisabled, false);

  traffic.setStatsimEnabled(true);
  axios.get = async () => ({ data: '<body>Departures: 3</body>' });
  assert.equal(await traffic.checkStatsimHealth(), false);
  assert.equal(traffic.getStatsimState().autoDisabled, true);
});
