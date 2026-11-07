const { DateTime } = require('luxon');

const NZ_ZONE = 'Pacific/Auckland';

function parseDdMm(dateStr) {
  if (!/^\d{2}\/\d{2}$/.test(String(dateStr))) return null;
  const [day, month] = String(dateStr).split('/').map(Number);
  if (month < 1 || month > 12) return null;
  const check = DateTime.fromObject({ year: DateTime.now().setZone(NZ_ZONE).year, month, day }, { zone: NZ_ZONE });
  if (!check.isValid) return null;
  return { day, month };
}

function parseHhmm(time) {
  const raw = String(time).padStart(4, '0');
  if (!/^\d{4}$/.test(raw)) return null;
  const hour = Number(raw.slice(0, 2));
  const minute = Number(raw.slice(2));
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { raw, hour, minute };
}

function getDurationMinutes(startTime, endTime) {
  const start = parseHhmm(startTime);
  const end = parseHhmm(endTime);
  if (!start || !end) return null;
  return (end.hour * 60 + end.minute) - (start.hour * 60 + start.minute);
}

function buildNzDateTime(dateStr, timeStr, year) {
  const date = parseDdMm(dateStr);
  const time = parseHhmm(timeStr);
  if (!date || !time) return null;

  const value = DateTime.fromObject(
    { year, month: date.month, day: date.day, hour: time.hour, minute: time.minute },
    { zone: NZ_ZONE }
  );

  return value.isValid ? value : null;
}

// Resolve the NZ date once so start and end always belong to the same day.
function resolveBookingWindow(date, start, end, existing = null) {
  const now = DateTime.now().setZone(NZ_ZONE);
  const stored = existing && date === existing.date ? getBookingDisplayInterval(existing) : null;
  let startNz = buildNzDateTime(date, start, stored?.startNz.year || now.year);
  if (!startNz) return null;
  if (!stored && startNz.startOf('day') < now.startOf('day')) startNz = startNz.plus({ years: 1 });
  const endNz = buildNzDateTime(date, end, startNz.year);
  const active = stored && stored.startNz <= now && stored.endNz > now;
  if (!endNz || endNz <= startNz || endNz <= now || (!active && startNz < now)) return null;
  if (startNz.toFormat('HHmm') !== parseHhmm(start)?.raw || endNz.toFormat('HHmm') !== parseHhmm(end)?.raw) return null;
  return { startNz, endNz, startUtc: startNz.toUTC().toISO(), endUtc: endNz.toUTC().toISO() };
}

function getBookingIntervalNz(booking, year) {
  const startNz = buildNzDateTime(booking?.date, booking?.start, year);
  const endNz = buildNzDateTime(booking?.date, booking?.end, year);
  if (!startNz || !endNz) return null;
  return { startNz, endNz };
}

function getStoredUtcDateTime(value) {
  const parsed = DateTime.fromISO(String(value || ''), { zone: 'utc' });
  return parsed.isValid ? parsed.toUTC() : null;
}

function getBookingDisplayInterval(booking, referenceYear = null) {
  const storedStartUtc = getStoredUtcDateTime(booking?.startUtc);
  const storedEndUtc = getStoredUtcDateTime(booking?.endUtc);
  if (storedStartUtc && storedEndUtc) {
    return {
      startUtc: storedStartUtc,
      endUtc: storedEndUtc,
      startNz: storedStartUtc.setZone(NZ_ZONE),
      endNz: storedEndUtc.setZone(NZ_ZONE)
    };
  }

  const nowNz = DateTime.now().setZone(NZ_ZONE);
  const year = referenceYear || nowNz.year;
  let startNz = buildNzDateTime(booking?.date, booking?.start, year);
  let endNz = buildNzDateTime(booking?.date, booking?.end, year);
  if (!startNz || !endNz) return null;

  if (endNz <= startNz) {
    endNz = endNz.plus({ days: 1 });
  }

  if (endNz < nowNz.minus({ hours: 1 })) {
    startNz = startNz.plus({ years: 1 });
    endNz = endNz.plus({ years: 1 });
  }

  return {
    startUtc: startNz.toUTC(),
    endUtc: endNz.toUTC(),
    startNz,
    endNz
  };
}

function toDiscordTimestamp(dateTime, style = 'f') {
  if (!dateTime?.isValid) return null;
  return `<t:${Math.floor(dateTime.toUTC().toSeconds())}:${style}>`;
}

function formatBookingDateForDiscord(booking) {
  const interval = getBookingDisplayInterval(booking);
  return interval ? toDiscordTimestamp(interval.startUtc, 'D') : null;
}

function formatBookingStartForDiscord(booking) {
  const interval = getBookingDisplayInterval(booking);
  return interval ? toDiscordTimestamp(interval.startUtc, 't') : null;
}

function formatBookingEndForDiscord(booking) {
  const interval = getBookingDisplayInterval(booking);
  return interval ? toDiscordTimestamp(interval.endUtc, 't') : null;
}

function formatBookingWindowForDiscord(booking) {
  const interval = getBookingDisplayInterval(booking);
  if (!interval) return null;
  return `${toDiscordTimestamp(interval.startUtc, 'F')} to ${toDiscordTimestamp(interval.endUtc, 'F')}`;
}

function getEventDateTimes(eventData) {
  const startUtc = DateTime.fromISO(eventData?.startUtcISO || eventData?.start, { zone: 'utc' });
  const endUtc = DateTime.fromISO(eventData?.endUtcISO || eventData?.end, { zone: 'utc' });
  if (!startUtc.isValid || !endUtc.isValid) return null;
  return {
    startUtc,
    endUtc,
    startNz: startUtc.setZone(NZ_ZONE),
    endNz: endUtc.setZone(NZ_ZONE)
  };
}

function bookingOverlapsEvent(booking, eventData) {
  const eventTimes = getEventDateTimes(eventData);
  if (!eventTimes) return false;
  const bookingTimes = getBookingIntervalNz(booking, eventTimes.startNz.year);
  if (!bookingTimes) return false;
  return bookingTimes.startNz < eventTimes.endNz && bookingTimes.endNz > eventTimes.startNz;
}

function getPreviousWeekNZ(dateStr, startHHMM = '0000') {
  const [day, month] = dateStr.split('/').map(Number);
  const hhmm = String(startHHMM).padStart(4, '0');
  const hour = Number(hhmm.slice(0, 2));
  const minute = Number(hhmm.slice(2));
  const nowNZ = DateTime.now().setZone(NZ_ZONE);

  let bookingDate = DateTime.fromObject(
    { year: nowNZ.year, month, day, hour, minute },
    { zone: NZ_ZONE }
  );

  if (!bookingDate.isValid) {
    return nowNZ.minus({ days: 7 }).toFormat('yyyy-MM-dd');
  }

  if (bookingDate < nowNZ) {
    bookingDate = bookingDate.plus({ years: 1 });
  }

  return bookingDate.minus({ days: 7 }).toFormat('yyyy-MM-dd');
}

function hhmmToClock(hhmm) {
  const raw = String(hhmm).padStart(4, '0');
  return `${raw.slice(0, 2)}:${raw.slice(2)}`;
}

function buildUtcWindowFromNz(date, start = '0000', end = '2359') {
  const [year, month, day] = String(date).split('-').map(Number);
  const startRaw = String(start).padStart(4, '0');
  const endRaw = String(end).padStart(4, '0');

  const startHour = Number(startRaw.slice(0, 2));
  const startMinute = Number(startRaw.slice(2));
  const endHour = Number(endRaw.slice(0, 2));
  const endMinute = Number(endRaw.slice(2));

  const fromNz = DateTime.fromObject(
    { year, month, day, hour: startHour, minute: startMinute },
    { zone: NZ_ZONE }
  );
  const toNz = DateTime.fromObject(
    { year, month, day, hour: endHour, minute: endMinute },
    { zone: NZ_ZONE }
  );

  if (!fromNz.isValid || !toNz.isValid) {
    return null;
  }

  return {
    fromUtc: fromNz.toUTC().toFormat("yyyy-MM-dd'T'HH:mm"),
    toUtc: toNz.toUTC().toFormat("yyyy-MM-dd'T'HH:mm")
  };
}

function convertToUTC(dateStr, timeStr) {
  const [day, month] = dateStr.split('/').map(Number);
  let year = DateTime.now().setZone(NZ_ZONE).year;

  const hours = timeStr.slice(0, 2);
  const minutes = timeStr.slice(2);

  let nzDate = DateTime.fromObject({ year, month, day, hour: Number(hours), minute: Number(minutes) }, { zone: NZ_ZONE });
  const nowNZ = DateTime.now().setZone(NZ_ZONE);

  if (nzDate < nowNZ) {
    nzDate = nzDate.plus({ years: 1 });
  }

  return nzDate.toUTC().toISO();
}

module.exports = {
  DateTime,
  NZ_ZONE,
  parseDdMm,
  parseHhmm,
  getDurationMinutes,
  buildNzDateTime,
  resolveBookingWindow,
  getBookingIntervalNz,
  getBookingDisplayInterval,
  toDiscordTimestamp,
  formatBookingDateForDiscord,
  formatBookingStartForDiscord,
  formatBookingEndForDiscord,
  formatBookingWindowForDiscord,
  getEventDateTimes,
  bookingOverlapsEvent,
  getPreviousWeekNZ,
  hhmmToClock,
  buildUtcWindowFromNz,
  convertToUTC
};
