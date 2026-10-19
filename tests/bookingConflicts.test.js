const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findOverlappingBooking } = require('../src/utils/bookingConflicts');
const { getBookingDisplayInterval } = require('../src/utils/time');

function booking(start, end, day = '2026-10-20') {
  return { position: 'NZAA_TWR', startUtc: `${day}T${start}:00Z`, endUtc: `${day}T${end}:00Z` };
}

test('controller overlap blocks partial, enclosing and identical sessions across positions', () => {
  const existing = booking('05:00', '07:00');
  for (const [start, end] of [['04:30', '05:30'], ['06:30', '07:30'], ['04:00', '08:00'], ['05:30', '06:00'], ['05:00', '07:00']]) {
    assert.equal(findOverlappingBooking([existing], { ...booking(start, end), position: 'NZCH_APP' }), existing);
  }
});

test('back-to-back sessions, different dates and different years do not conflict', () => {
  const existing = booking('05:00', '07:00');
  for (const candidate of [booking('04:00', '05:00'), booking('07:00', '08:00'), booking('05:00', '07:00', '2026-10-21'), booking('05:00', '07:00', '2027-10-20')]) {
    assert.equal(findOverlappingBooking([existing], candidate), null);
  }
});

test('legacy records and windows crossing UTC midnight are checked', () => {
  const legacy = { date: '20/10', start: 1800, end: 2000, position: 'NZAA_TWR' };
  const interval = getBookingDisplayInterval(legacy);
  assert.equal(findOverlappingBooking(legacy, {
    startUtc: interval.startUtc.plus({ minutes: 30 }).toISO(),
    endUtc: interval.endUtc.plus({ minutes: 30 }).toISO()
  }), legacy);
  const overnight = { startUtc: '2026-10-20T23:30:00Z', endUtc: '2026-10-21T01:00:00Z' };
  assert.equal(findOverlappingBooking([overnight], booking('00:00', '02:00', '2026-10-21')), overnight);
  assert.equal(findOverlappingBooking([], booking('05:00', '07:00')), null);
});
