const { DateTime } = require('luxon');

function parseDdMm(dateStr) {
  if (!/^\d{2}\/\d{2}$/.test(String(dateStr))) return null;
  const [day, month] = String(dateStr).split('/').map(Number);
  if (month < 1 || month > 12) return null;
  const check = DateTime.fromObject({ year: DateTime.now().setZone('Pacific/Auckland').year, month, day }, { zone: 'Pacific/Auckland' });
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

function buildNzDateTime(dateStr, timeStr, year) {
  const date = parseDdMm(dateStr);
  const time = parseHhmm(timeStr);
  if (!date || !time) return null;

  const value = DateTime.fromObject(
    { year, month: date.month, day: date.day, hour: time.hour, minute: time.minute },
    { zone: 'Pacific/Auckland' }
  );

  return value.isValid ? value : null;
}

function getBookingIntervalNz(booking, year) {
  const startNz = buildNzDateTime(booking?.date, booking?.start, year);
  const endNz = buildNzDateTime(booking?.date, booking?.end, year);
  if (!startNz || !endNz) return null;
  return { startNz, endNz };
}

function getEventDateTimes(eventData) {
  const startUtc = DateTime.fromISO(eventData?.startUtcISO || eventData?.start, { zone: 'utc' });
  const endUtc = DateTime.fromISO(eventData?.endUtcISO || eventData?.end, { zone: 'utc' });
  if (!startUtc.isValid || !endUtc.isValid) return null;
  return {
    startUtc,
    endUtc,
    startNz: startUtc.setZone('Pacific/Auckland'),
    endNz: endUtc.setZone('Pacific/Auckland')
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
  const nowNZ = DateTime.now().setZone('Pacific/Auckland');

  let bookingDate = DateTime.fromObject(
    { year: nowNZ.year, month, day, hour, minute },
    { zone: 'Pacific/Auckland' }
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
    { zone: 'Pacific/Auckland' }
  );
  const toNz = DateTime.fromObject(
    { year, month, day, hour: endHour, minute: endMinute },
    { zone: 'Pacific/Auckland' }
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
  let year = new Date().getFullYear();

  const hours = timeStr.slice(0, 2);
  const minutes = timeStr.slice(2);

  let nzDate = DateTime.fromISO(`${year}-${month}-${day}T${hours}:${minutes}:00`).setZone('Pacific/Auckland');
  const nowNZ = DateTime.now().setZone('Pacific/Auckland');

  if (nzDate < nowNZ) {
    nzDate = nzDate.plus({ years: 1 });
  }

  return nzDate.toISO();
}

module.exports = {
  DateTime,
  parseDdMm,
  parseHhmm,
  buildNzDateTime,
  getBookingIntervalNz,
  getEventDateTimes,
  bookingOverlapsEvent,
  getPreviousWeekNZ,
  hhmmToClock,
  buildUtcWindowFromNz,
  convertToUTC
};
