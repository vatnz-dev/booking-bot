const { test } = require('node:test');
const assert = require('node:assert/strict');

let calendar = () => '';
require.cache[require.resolve('../src/utils/http')] = { loaded: true, exports: { get: async () => { const data = calendar(); if (data instanceof Error) throw data; return { data }; } } };
const { DateTime } = require('luxon');
const { getLimits, bookingLimitRefusal, mentorRequestRefusal } = require('../src/services/limits');

// The #11 spec: today is 1 Nov 2026; MAX_ACTIVE_BOOKINGS 3, MAX_BOOKING_DAYS_AHEAD 14.
const today = t => t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T09:00:00+13:00') });
const nz = (date, time) => DateTime.fromISO(`${date}T${time}`, { zone: 'Pacific/Auckland' }).toUTC().toISO();
const booking = (date, start, end, id = `${date}-${start}`) => ({ messageId: id, date, start: Number(start.replace(':', '')), end: Number(end.replace(':', '')), startUtc: nz(date, start), endUtc: nz(date, end) });
const events = [
  { uid: 'chch', title: 'Christchurch Control', startUtcISO: nz('2026-11-15', '18:00'), endUtcISO: nz('2026-11-15', '21:00') },
  { uid: 'akl', title: 'Auckland Arrivals', startUtcISO: nz('2026-11-29', '18:00'), endUtcISO: nz('2026-11-29', '21:00') }
];
const limits = { maxActiveBookings: 3, maxBookingDaysAhead: 14, mentorRequestCooldownHours: 3 };
const refusal = (candidate, others = [], extra = {}) => bookingLimitRefusal({ candidate, others, events, limits, ...extra });
const normal = n => Array.from({ length: n }, (_, i) => booking(`2026-11-0${2 + i}`, '10:00', '11:00'));

test('limits default to 3 bookings, 14 days and 3 hours, and read the environment', () => {
  assert.deepEqual(getLimits({}), { maxActiveBookings: 3, maxBookingDaysAhead: 14, mentorRequestCooldownHours: 3 });
  assert.deepEqual(getLimits({ MAX_ACTIVE_BOOKINGS: '5', MAX_BOOKING_DAYS_AHEAD: '30', MENTOR_REQUEST_COOLDOWN_HOURS: '1' }), { maxActiveBookings: 5, maxBookingDaysAhead: 30, mentorRequestCooldownHours: 1 });
  assert.equal(getLimits({ MAX_ACTIVE_BOOKINGS: 'lots' }).maxActiveBookings, 3, 'an unreadable value falls back to the default');
});

test('normal bookings: within the limits, at the cap, and too far ahead', async t => {
  today(t);
  assert.equal(await refusal(booking('2026-11-05', '10:00', '12:00'), normal(2)), null);
  assert.equal(await refusal(booking('2026-11-06', '10:00', '12:00'), normal(3)), 'You already have 3 active bookings, the maximum.');
  assert.equal(await refusal(booking('2026-11-20', '10:00', '12:00')), 'Bookings can be made up to 14 days ahead.');
  assert.equal(await refusal(booking('2026-11-15', '10:00', '12:00')), null, '14 days ahead is allowed');
  const ended = booking('2026-10-30', '10:00', '11:00');
  assert.equal(await refusal(booking('2026-11-05', '10:00', '12:00'), [...normal(2), ended]), null, 'bookings that have ended do not count');
});

test('event bookings: one for the next event only, and outside the normal cap', async t => {
  today(t);
  assert.equal(await refusal(booking('2026-11-15', '18:00', '21:00')), null);
  assert.equal(await refusal(booking('2026-11-15', '17:00', '18:30')), null, 'any overlap with the event counts');
  const held = booking('2026-11-15', '18:00', '21:00', 'held');
  assert.equal(await refusal(booking('2026-11-15', '19:00', '20:00'), [held]), 'You already have a booking for Christchurch Control.');
  assert.equal(await refusal(booking('2026-11-29', '18:00', '21:00')), 'Event bookings open for the next event only: Christchurch Control on 15 Nov.');
  assert.equal(await refusal(booking('2026-11-15', '18:00', '21:00'), normal(3)), null, 'event bookings do not count towards the normal cap');
  assert.equal(await refusal(booking('2026-11-05', '10:00', '12:00'), [...normal(2), held]), null, 'an event booking is not one of the normal bookings');
  assert.equal(await refusal(booking('2026-11-15', '16:00', '18:00'), normal(3)), 'You already have 3 active bookings, the maximum.', 'ending as the event starts is a normal booking');
});

test('edits: kept dates are never refused for being far ahead, and a normal booking edit adds nothing to the count', async t => {
  today(t);
  const far = booking('2026-12-20', '10:00', '12:00', 'far');
  assert.equal(await refusal({ ...far, end: 1300, endUtc: nz('2026-12-20', '13:00') }, [], { previous: far }), null);
  assert.equal(await refusal(booking('2026-12-21', '10:00', '12:00', 'far'), [], { previous: far }), 'Bookings can be made up to 14 days ahead.');
  const mine = booking('2026-11-05', '10:00', '12:00', 'mine');
  assert.equal(await refusal(booking('2026-11-06', '10:00', '12:00', 'mine'), normal(3), { previous: mine }), null);
  const eventBooking = booking('2026-11-15', '18:00', '21:00', 'evt');
  assert.equal(await refusal(booking('2026-11-06', '10:00', '12:00', 'evt'), normal(3), { previous: eventBooking }), 'You already have 3 active bookings, the maximum.', 'moving out of an event adds a normal booking');
});

test('without any calendar, every booking counts as a normal booking', async t => {
  today(t);
  calendar = () => new Error('calendar down');
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  assert.equal(await bookingLimitRefusal({ candidate: booking('2026-11-15', '18:00', '21:00'), others: normal(3), limits }), 'You already have 3 active bookings, the maximum.');
  assert.ok(lines.some(l => l.includes('booking_limits_calendar_unavailable')));
});

test('one mentor request per booking every 3 hours, from the time saved on the booking', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T11:30:00+13:00') });
  const sent = { mentorRequestedAt: new Date(Date.parse('2026-11-01T10:00:00+13:00')).toISOString() };
  assert.equal(mentorRequestRefusal(sent, limits), 'You can send another mentor request for this booking after 13:00.');
  assert.equal(mentorRequestRefusal({}, limits), null, 'the first request is allowed');
  t.mock.timers.setTime(Date.parse('2026-11-01T13:05:00+13:00'));
  assert.equal(mentorRequestRefusal(sent, limits), null);
});
