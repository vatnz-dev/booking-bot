const { getBookingDisplayInterval } = require('./time');

function findOverlappingBooking(bookings, candidate) {
  const requested = getBookingDisplayInterval(candidate);
  if (!requested) return null;
  const list = Array.isArray(bookings) ? bookings : (bookings ? [bookings] : []);
  return list.find(booking => {
    const existing = getBookingDisplayInterval(booking);
    return existing && requested.startUtc < existing.endUtc && requested.endUtc > existing.startUtc;
  }) || null;
}

module.exports = { findOverlappingBooking };
