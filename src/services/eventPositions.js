const { DateTime, NZ_ZONE } = require('../utils/time');
const { log, logFailures } = require('../utils/log');

// Storage: event[position] = ['2026-11-15', ...] (NZ dates); eventclose[position] = { '2026-11-15': announcementMessageId }.
// Older versions stored one 'DD/MM' string ('0/0' = closed) and one message ID; those are read as a single date.

const DATE_INPUT = /^(\d{2})\/(\d{2})(?:\/(\d{4}))?$/;
const today = () => DateTime.now().setZone(NZ_ZONE).toISODate();

function formatOpenDate(iso) {
  return DateTime.fromISO(iso, { zone: NZ_ZONE }).toFormat('d LLL yyyy');
}

function describeOpenDates(dates) {
  const labels = dates.map(formatOpenDate);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0];
}

// A legacy 'DD/MM' had no year: use its nearest occurrence (this year or next), so a recently passed date closes automatically.
function legacyDate(value) {
  const match = /^(\d{1,2})\/(\d{1,2})$/.exec(String(value || ''));
  if (!match || value === '0/0') return null;
  const now = DateTime.now().setZone(NZ_ZONE).startOf('day');
  const candidates = [now.year, now.year + 1]
    .map(year => DateTime.fromObject({ year, month: Number(match[2]), day: Number(match[1]) }, { zone: NZ_ZONE }))
    .filter(date => date.isValid);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => Math.abs(a.diff(now).as('days')) - Math.abs(b.diff(now).as('days')))[0].toISODate();
}

function getOpenDates(event, position) {
  const raw = event.get(position);
  if (Array.isArray(raw)) return raw;
  const legacy = legacyDate(raw);
  return legacy ? [legacy] : [];
}

function readPosition({ event, eventclose }, position) {
  const dates = getOpenDates(event, position);
  const raw = eventclose.get(position);
  const messages = raw && typeof raw === 'object' ? { ...raw } : (typeof raw === 'string' && dates.length === 1 ? { [dates[0]]: raw } : {});
  return { dates, messages };
}

function writePosition({ event, eventclose }, position, { dates, messages }) {
  const kept = [...new Set(dates)].sort();
  event.set(position, kept);
  eventclose.set(position, Object.fromEntries(Object.entries(messages).filter(([date]) => kept.includes(date))));
}

// Opening: DD/MM means this year; DD/MM/YYYY for any year. Today is allowed, the past isn't.
function parseOpenDate(input) {
  const text = String(input || '').trim();
  const match = DATE_INPUT.exec(text);
  const now = DateTime.now().setZone(NZ_ZONE);
  const date = match && DateTime.fromObject({ year: Number(match[3] || now.year), month: Number(match[2]), day: Number(match[1]) }, { zone: NZ_ZONE });
  if (!date?.isValid) return { error: `${text} isn't a real date. Use DD/MM or DD/MM/YYYY.` };
  const iso = date.toISODate();
  if (iso < today()) {
    return { error: match[3] ? `${formatOpenDate(iso)} has passed.` : `${formatOpenDate(iso)} has passed. For next year, use DD/MM/YYYY.` };
  }
  return { iso };
}

// Closing one date: DD/MM matches that day in any open year; DD/MM/YYYY matches exactly.
function matchOpenDates(dates, input) {
  const match = DATE_INPUT.exec(String(input || '').trim());
  if (!match) return [];
  return dates.filter(iso => {
    const [year, month, day] = iso.split('-');
    return day === match[1] && month === match[2] && (!match[3] || year === match[3]);
  });
}

// Null when the booking date is open; otherwise the refusal to show.
function eventPositionRefusal(event, position, isoDate) {
  const dates = getOpenDates(event, position);
  if (!dates.length) return 'This event-only position is not open for bookings right now.';
  return dates.includes(isoDate) ? null : `${position} is only open on ${describeOpenDates(dates)}.`;
}

async function deleteAnnouncement(getBookingChannel, messageId) {
  if (!messageId) return;
  const channel = await getBookingChannel();
  try {
    const message = await channel?.messages?.fetch(messageId);
    await message?.delete();
  } catch (err) {
    if (err?.code !== 10008) log('warn', 'event_position_message_delete_failed', { messageId, error: err });
  }
}

async function closeExpiredEventPositions({ event, eventclose, getBookingChannel, sendAuditLog }) {
  const cutoff = today();
  for (const { key: position } of event.all()) {
    const state = readPosition({ event, eventclose }, position);
    const expired = state.dates.filter(date => date < cutoff);
    if (!expired.length) continue;
    for (const date of expired) {
      await deleteAnnouncement(getBookingChannel, state.messages[date]);
      await sendAuditLog({
        action: 'Event Position Closed Automatically',
        actorLabel: 'System',
        reason: 'The open date has passed',
        fields: [{ name: 'Position', value: position, inline: true }, { name: 'Date', value: formatOpenDate(date), inline: true }],
        color: '#D9534F'
      });
    }
    writePosition({ event, eventclose }, position, { ...state, dates: state.dates.filter(date => !expired.includes(date)) });
  }
}

function startEventPositionScheduler(deps) {
  const run = logFailures('event_position_auto_close', {}, () => closeExpiredEventPositions(deps));
  run();
  setInterval(run, 60 * 60 * 1000);
}

module.exports = {
  formatOpenDate,
  describeOpenDates,
  getOpenDates,
  readPosition,
  writePosition,
  parseOpenDate,
  matchOpenDates,
  eventPositionRefusal,
  deleteAnnouncement,
  closeExpiredEventPositions,
  startEventPositionScheduler
};
