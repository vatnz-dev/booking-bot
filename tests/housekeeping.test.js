const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pruneEventRecords, pruneEndorsementWarnings } = require('../src/services/housekeeping');

const store = initial => {
  const data = new Map(Object.entries(initial));
  return { data, all: () => [...data].map(([key, value]) => ({ key, data: value })), delete: key => data.delete(key) };
};
const now = Date.parse('2026-11-08T00:00:00Z');
const capture = t => { const lines = []; t.mock.method(console, 'log', l => lines.push(JSON.parse(l))); return lines; };

test('event records are removed 30 days after the event ends, and the removal is logged', t => {
  const lines = capture(t);
  const event = (uid, endUtcISO, status = 'deleted') => ({ status, event: { uid, title: uid, endUtcISO } });
  const eventThreads = store({
    old: event('old', '2026-10-01T09:00:00Z'),
    recent: event('recent', '2026-10-20T09:00:00Z'),
    upcoming: event('upcoming', '2026-11-20T09:00:00Z', 'prompted'),
    noEvent: { status: 'declined' }
  });
  pruneEventRecords(eventThreads, now);
  assert.deepEqual([...eventThreads.data.keys()], ['recent', 'upcoming', 'noEvent']);
  assert.deepEqual(lines.map(l => [l.event, l.uid]), [['event_record_pruned', 'old']]);
});

test('endorsement warnings are removed 30 days after the endorsement expires', t => {
  const lines = capture(t);
  const warnings = store({
    'user:1234567:solo:NZAA_APP:2026-09-30:1': { sentAt: '2026-09-29T00:00:00Z' },
    'user:1234567:solo:NZAA_APP,_NZCH_APP:2026-10-15:30': { sentAt: '2026-09-15T00:00:00Z' },
    'user:7654321:s1_622:NZAA_DEL,_GND,_TWR:2026-12-31:30': { sentAt: '2026-12-01T00:00:00Z' }
  });
  pruneEndorsementWarnings(warnings, now);
  assert.deepEqual([...warnings.data.keys()], ['user:1234567:solo:NZAA_APP,_NZCH_APP:2026-10-15:30', 'user:7654321:s1_622:NZAA_DEL,_GND,_TWR:2026-12-31:30']);
  assert.equal(lines[0].event, 'endorsement_warning_pruned');
});
