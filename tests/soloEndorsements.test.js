const { test } = require('node:test');
const assert = require('node:assert/strict');

let pages;
let requests = 0;
require.cache[require.resolve('../src/utils/http')] = {
  loaded: true,
  exports: { get: async url => { requests++; const page = pages(url); if (page instanceof Error) throw page; return { data: page }; } }
};
const { fetchSoloEndorsements, parseApprovedSoloEndorsements, applySoloEndorsementOverride, buildOverrideAuditEntry } = require('../src/services/soloEndorsements');

const SOLO_HEADER = '<tr><th>Name</th><th>CID</th><th>Position</th><th>Start Date</th><th>End Date</th><th>Approved</th></tr>';
const S1_HEADER = '<tr><th>Name</th><th>CID</th><th>Location(s)</th><th>Position(s)</th><th>Approved by</th><th>Issue Date</th><th>Expiry Date</th><th>Conditions</th></tr>';
const soloPage = rows => `<h2>Aerodrome</h2><table>${SOLO_HEADER}${rows}</table>`;
const s1Page = `<table>${S1_HEADER}</table>`;
const samRow = '<tr><td>Sam</td><td>1234567</td><td>NZCH_TWR</td><td>01/10/2026</td><td>30/11/2027</td><td>Taylor</td></tr>';
const serve = solo => url => (url.includes('s1-holders') ? s1Page : solo);
const quiet = t => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {}); };

test('only tables with the endorsement columns are read', () => {
  const stray = '<table><tr><th>Name</th><th>CID</th><th>Notes</th></tr><tr><td>Mallory</td><td>7654321</td><td>NZAA_APP</td><td>01/01/2026</td><td>01/01/2030</td><td>x</td></tr></table>';
  const parsed = parseApprovedSoloEndorsements(stray + soloPage(samRow));
  assert.deepEqual(parsed.map(e => e.cid), ['1234567']);
  assert.throws(() => parseApprovedSoloEndorsements(stray), /Endorsement table not found/);
});

test('cache rules: valid empty list kept 6 h, failure falls back for 24 h then fails closed, no retry for 15 min', async t => {
  quiet(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 23) });
  const audits = [];
  const audit = async e => audits.push(e);
  const hour = 60 * 60 * 1000;

  pages = serve(soloPage(''));
  assert.deepEqual(await fetchSoloEndorsements({ audit }), []);
  t.mock.timers.tick(5 * hour);
  await fetchSoloEndorsements({ audit });
  assert.equal(requests, 2, 'a valid empty list is cached for 6 hours');

  pages = serve(soloPage(samRow));
  t.mock.timers.tick(2 * hour);
  assert.equal((await fetchSoloEndorsements({ audit })).length, 1);

  pages = serve('<p>Maintenance</p>');
  t.mock.timers.tick(7 * hour);
  assert.equal((await fetchSoloEndorsements({ audit })).length, 1, 'a page without the table is a failure, so the older list is used');
  assert.equal(audits.at(-1).action, 'Using Older Endorsement List');
  const before = requests;
  t.mock.timers.tick(10 * 60 * 1000);
  await fetchSoloEndorsements({ audit });
  assert.equal(requests, before, 'no retry within 15 minutes of a failure');

  t.mock.timers.tick(18 * hour);
  await assert.rejects(fetchSoloEndorsements({ audit }), /Endorsement table not found/);
  assert.equal(audits.at(-1).action, 'Endorsement Overrides Suspended');

  const eligibility = await applySoloEndorsementOverride({
    baseEligibility: { allowed: true, mentorRequired: true }, cid: '1234567', member: {}, position: 'NZCH_TWR',
    bookingDateNz: require('../src/utils/time').DateTime.fromISO('2026-11-15', { zone: 'Pacific/Auckland' }), audit
  });
  assert.equal(eligibility.mentorRequired, true, 'with no trusted list, the override is not applied');
});

test('an applied override produces an audit entry naming the controller and endorsement', () => {
  const [endorsement] = parseApprovedSoloEndorsements(soloPage(samRow));
  const entry = buildOverrideAuditEntry(endorsement, 'sam', { position: 'NZCH_TWR' });
  assert.equal(entry.action, 'Endorsement Override Used');
  assert.equal(entry.targetUserId, 'sam');
  assert.match(entry.reason, /NZCH_TWR \(expires 30\/11\/2027\) lets this booking skip mentor approval/);
});
