const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseOpenDate, readPosition, eventPositionRefusal, matchOpenDates, closeExpiredEventPositions } = require('../src/services/eventPositions');

// "Today" in the #14 spec is 22 Oct 2026, NZ time.
const at = (t, iso) => t.mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
const store = initial => {
  const map = new Map(Object.entries(initial));
  return { map, get: k => map.get(k), set: (k, v) => map.set(k, v), all: () => [...map].map(([key, data]) => ({ key, data })) };
};

test('opening dates: DD/MM is this year, DD/MM/YYYY any year, impossible and past dates are refused', t => {
  at(t, '2026-10-22T00:00:00+13:00');
  assert.deepEqual(parseOpenDate('15/11'), { iso: '2026-11-15' });
  assert.deepEqual(parseOpenDate('10/01/2027'), { iso: '2027-01-10' });
  assert.deepEqual(parseOpenDate('22/10'), { iso: '2026-10-22' }, 'today is allowed');
  assert.equal(parseOpenDate('99/99').error, "99/99 isn't a real date. Use DD/MM or DD/MM/YYYY.");
  assert.equal(parseOpenDate('31/02').error, "31/02 isn't a real date. Use DD/MM or DD/MM/YYYY.");
  assert.equal(parseOpenDate('21/10').error, '21 Oct 2026 has passed. For next year, use DD/MM/YYYY.');
  assert.equal(parseOpenDate('15/11/2025').error, '15 Nov 2025 has passed.');
});

test('bookings must match an open date, including the year', t => {
  at(t, '2026-10-22T00:00:00+13:00');
  const event = store({ NZAA_DEP: ['2026-11-15'] });
  assert.equal(eventPositionRefusal(event, 'NZAA_DEP', '2026-11-15'), null);
  assert.equal(eventPositionRefusal(event, 'NZAA_DEP', '2027-11-15'), 'NZAA_DEP is only open on 15 Nov 2026.');
  event.set('NZAA_DEP', ['2026-11-15', '2026-11-29']);
  assert.equal(eventPositionRefusal(event, 'NZAA_DEP', '2026-12-01'), 'NZAA_DEP is only open on 15 Nov 2026 and 29 Nov 2026.');
  assert.equal(eventPositionRefusal(store({}), 'NZAA_DEP', '2026-11-15'), 'This event-only position is not open for bookings right now.');
});

test('values saved by older versions are read as one date at its nearest occurrence', t => {
  at(t, '2026-11-07T12:00:00+13:00');
  const read = (date, message) => readPosition({ event: store({ P: date }), eventclose: store(message ? { P: message } : {}) }, 'P');
  assert.deepEqual(read('15/11', 'msg'), { dates: ['2026-11-15'], messages: { '2026-11-15': 'msg' } });
  assert.deepEqual(read('10/01').dates, ['2027-01-10'], 'January opened in November means next year');
  assert.deepEqual(read('15/10').dates, ['2026-10-15'], 'a recently passed date stays in the past, so it closes automatically');
  assert.deepEqual(read('0/0').dates, []);
  assert.deepEqual(read(undefined).dates, []);
});

test('closing one date matches DD/MM in any open year, or DD/MM/YYYY exactly', () => {
  const dates = ['2026-11-15', '2026-11-29', '2027-11-15'];
  assert.deepEqual(matchOpenDates(dates, '29/11'), ['2026-11-29']);
  assert.deepEqual(matchOpenDates(dates, '15/11/2027'), ['2027-11-15']);
  assert.deepEqual(matchOpenDates(dates, '01/12'), []);
});

test('a position closes automatically once its date has passed', async t => {
  at(t, '2026-11-16T00:30:00+13:00');
  const event = store({ NZAA_DEP: ['2026-11-15', '2026-11-29'] });
  const eventclose = store({ NZAA_DEP: { '2026-11-15': 'post-15', '2026-11-29': 'post-29' } });
  const deleted = [];
  const audits = [];
  await closeExpiredEventPositions({
    event, eventclose,
    getBookingChannel: async () => ({ messages: { fetch: async id => ({ delete: async () => deleted.push(id) }) } }),
    sendAuditLog: async entry => audits.push(entry)
  });
  assert.deepEqual(event.map.get('NZAA_DEP'), ['2026-11-29']);
  assert.deepEqual(eventclose.map.get('NZAA_DEP'), { '2026-11-29': 'post-29' });
  assert.deepEqual(deleted, ['post-15']);
  assert.equal(audits[0].action, 'Event Position Closed Automatically');
  assert.deepEqual(audits[0].fields.map(f => f.value), ['NZAA_DEP', '15 Nov 2026']);
});
