const { DateTime, NZ_ZONE, getBookingDisplayInterval, getEventDateTimes } = require('../utils/time');
const { log } = require('../utils/log');
const { fetchVatnzEvents } = require('./eventThreads');

// Every limit is read through getLimits(), so a saved override (a future /maintenance limits command)
// only needs adding here. Nothing else reads these settings directly.
const LIMITS = {
  maxActiveBookings: { env: 'MAX_ACTIVE_BOOKINGS', fallback: 3 },
  maxBookingDaysAhead: { env: 'MAX_BOOKING_DAYS_AHEAD', fallback: 14 },
  mentorRequestCooldownHours: { env: 'MENTOR_REQUEST_COOLDOWN_HOURS', fallback: 3 }
};

function getLimits(env = process.env) {
  return Object.fromEntries(Object.entries(LIMITS).map(([name, { env: key, fallback }]) => {
    const value = Number(env[key]);
    return [name, Number.isInteger(value) && value > 0 ? value : fallback];
  }));
}

// The last good calendar is kept when a refresh fails; with none yet, every booking counts as a normal booking.
const CALENDAR_REFRESH_MS = 5 * 60 * 1000;
let calendar = { fetchedAt: 0, events: [] };

async function getCalendarEvents() {
  if (Date.now() - calendar.fetchedAt < CALENDAR_REFRESH_MS) return calendar.events;
  try {
    calendar = { fetchedAt: Date.now(), events: await fetchVatnzEvents() };
  } catch (error) {
    calendar.fetchedAt = Date.now();
    log('warn', 'booking_limits_calendar_unavailable', { error, cachedEvents: calendar.events.length });
  }
  return calendar.events;
}

// Any overlap counts, not just a booking inside the event window; back-to-back doesn't.
function overlappingEvent(booking, events) {
  const interval = getBookingDisplayInterval(booking);
  if (!interval) return null;
  return events.find(eventData => {
    const times = getEventDateTimes(eventData);
    return times && interval.startUtc < times.endUtc && interval.endUtc > times.startUtc;
  }) || null;
}

// Null when the booking is within the limits, otherwise the refusal to show.
// `others` are the owner's other bookings; `previous` is the booking being edited, if any.
async function bookingLimitRefusal({ candidate, others = [], previous = null, limits = getLimits(), events }) {
  const now = DateTime.now().setZone(NZ_ZONE);
  const upcoming = (events ?? await getCalendarEvents())
    .filter(eventData => getEventDateTimes(eventData)?.endUtc > now)
    .sort((a, b) => getEventDateTimes(a).startUtc - getEventDateTimes(b).startUtc);
  const next = upcoming[0];

  const eventData = overlappingEvent(candidate, upcoming);
  if (eventData) {
    if (eventData.uid !== next.uid) {
      return `Event bookings open for the next event only: ${next.title} on ${getEventDateTimes(next).startNz.toFormat('d LLL')}.`;
    }
    return others.some(booking => overlappingEvent(booking, [next])) ? `You already have a booking for ${next.title}.` : null;
  }

  // An edit that keeps its date and times is never refused for being far ahead, so older bookings stay editable.
  const interval = getBookingDisplayInterval(candidate);
  const moved = !previous || getBookingDisplayInterval(previous)?.startUtc.toMillis() !== interval?.startUtc.toMillis();
  if (moved && interval && interval.startNz.startOf('day') > now.startOf('day').plus({ days: limits.maxBookingDaysAhead })) {
    return `Bookings can be made up to ${limits.maxBookingDaysAhead} days ahead.`;
  }

  // Editing a normal booking can't add to the count; only a new booking or an event booking moved out of its event can.
  if (previous && !overlappingEvent(previous, upcoming)) return null;
  const active = others.filter(booking => getBookingDisplayInterval(booking)?.endUtc > now && !overlappingEvent(booking, upcoming));
  if (active.length >= limits.maxActiveBookings) {
    return active.length === limits.maxActiveBookings
      ? `You already have ${active.length} active bookings, the maximum.`
      : `You already have ${active.length} active bookings; the maximum is ${limits.maxActiveBookings}.`;
  }
  return null;
}

// Null when a mentor request may be sent now, otherwise the refusal naming when the next one is allowed.
function mentorRequestRefusal(booking, limits = getLimits()) {
  const last = Date.parse(booking?.mentorRequestedAt || '');
  const allowedAt = last + limits.mentorRequestCooldownHours * 60 * 60 * 1000;
  if (!last || Date.now() >= allowedAt) return null;
  const at = DateTime.fromMillis(allowedAt).setZone(NZ_ZONE);
  const sameDay = at.hasSame(DateTime.now().setZone(NZ_ZONE), 'day');
  return `You can send another mentor request for this booking after ${at.toFormat(sameDay ? 'HH:mm' : 'd LLL HH:mm')}.`;
}

module.exports = { getLimits, bookingLimitRefusal, mentorRequestRefusal };
