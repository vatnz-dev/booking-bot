const http = require('../utils/http');
const cheerio = require('cheerio');

const {
  ENDORSEMENT_WARNING_CHECK_MS,
  ENDORSEMENT_WARNING_DAYS,
  S1_SOLO_ENDORSEMENTS_URL,
  SOLO_ENDORSEMENT_CACHE_MS,
  SOLO_ENDORSEMENTS_URL
} = require('../constants');
const { DateTime, buildNzDateTime } = require('../utils/time');
const { log } = require('../utils/log');
const { getControllerTier } = require('./positions');

const NZ_ZONE = 'Pacific/Auckland';

const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;
// Past this age an old copy is no longer trusted: overrides stop and bookings need mentor approval.
const MAX_STALE_MS = 24 * 60 * 60 * 1000;

let endorsementCache = {
  fetchedAt: 0,
  failedAt: 0,
  endorsements: null
};

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseNzDate(value) {
  const raw = normalizeText(value);
  if (!raw) return null;

  const formats = ['dd/MM/yyyy', 'd/MM/yyyy', 'dd/M/yyyy', 'd/M/yyyy', 'dd/MM/yy', 'd/MM/yy', 'dd/M/yy', 'd/M/yy', 'd LLLL yyyy', 'dd LLLL yyyy'];
  for (const format of formats) {
    const parsed = DateTime.fromFormat(raw, format, { zone: NZ_ZONE });
    if (parsed.isValid) return parsed.startOf('day');
  }

  const iso = DateTime.fromISO(raw, { zone: NZ_ZONE });
  return iso.isValid ? iso.startOf('day') : null;
}

function getTableHeading($, table) {
  const caption = normalizeText($(table).find('caption').first().text());
  if (caption) return caption;

  let node = $(table).prev();
  while (node.length > 0) {
    const tag = node[0]?.tagName?.toLowerCase();
    const text = normalizeText(node.text());
    if (/^h[1-6]$/.test(tag) && text) return text;
    node = node.prev();
  }
  return 'Solo Endorsement';
}

// Only tables whose header row has these columns are endorsement tables; anything else on the page is ignored.
function findEndorsementTables($, columns, url) {
  const tables = $('table').filter((_, table) => {
    const header = $(table).find('tr').first().find('th, td').map((__, cell) => normalizeText($(cell).text())).get();
    return columns.every(column => header.includes(column));
  });
  if (tables.length === 0) throw new Error(`Endorsement table not found on ${url}`);
  return tables;
}

function parseApprovedSoloEndorsements(html) {
  const $ = cheerio.load(html);
  const endorsements = [];

  findEndorsementTables($, ['CID', 'Position', 'End Date'], SOLO_ENDORSEMENTS_URL).each((_, table) => {
    const category = getTableHeading($, table);
    $(table).find('tr').slice(1).each((__, row) => {
      const cells = $(row).find('td').map((___, cell) => normalizeText($(cell).text())).get();
      if (cells.length < 6 || cells.every(cell => !cell)) return;

      const [name, cid, position, startDate, endDate, approvedBy] = cells;
      const startDateNz = parseNzDate(startDate);
      const endDateNz = parseNzDate(endDate);
      if (!cid || !position || !endDateNz) return;

      endorsements.push({
        source: 'solo',
        category,
        name,
        cid: String(cid),
        position: position.toUpperCase(),
        positions: [position.toUpperCase()],
        locations: [],
        startDate,
        endDate,
        startDateISO: startDateNz?.toISODate() || null,
        endDateISO: endDateNz.toISODate(),
        approvedBy,
        url: SOLO_ENDORSEMENTS_URL
      });
    });
  });

  return endorsements;
}

function splitList(value) {
  return normalizeText(value)
    .split(',')
    .map(part => part.trim().toUpperCase())
    .filter(Boolean);
}

function parseS1SoloEndorsements(html) {
  const $ = cheerio.load(html);
  const endorsements = [];

  findEndorsementTables($, ['CID', 'Location(s)', 'Position(s)', 'Expiry Date'], S1_SOLO_ENDORSEMENTS_URL).each((_, table) => {
    $(table).find('tr').slice(1).each((__, row) => {
      const cells = $(row).find('td').map((___, cell) => normalizeText($(cell).text())).get();
      if (cells.length < 7 || cells.every(cell => !cell)) return;

      const [name, cid, locationsRaw, positionsRaw, approvedBy, issueDate, expiryDate] = cells;
      const startDateNz = parseNzDate(issueDate);
      const endDateNz = parseNzDate(expiryDate);
      const locations = splitList(locationsRaw);
      const suffixes = splitList(positionsRaw);
      if (!cid || locations.length === 0 || suffixes.length === 0 || !endDateNz) return;

      endorsements.push({
        source: 's1_622',
        category: 'S1 6.2.2',
        name,
        cid: String(cid),
        position: `${locations.join(', ')} ${suffixes.join(', ')}`,
        positions: suffixes,
        locations,
        startDate: issueDate,
        endDate: expiryDate,
        startDateISO: startDateNz?.toISODate() || null,
        endDateISO: endDateNz.toISODate(),
        approvedBy,
        url: S1_SOLO_ENDORSEMENTS_URL
      });
    });
  });

  return endorsements;
}

// `audit` is sendAuditLog; fallbacks and suspensions are posted once per failed download.
async function fetchSoloEndorsements({ force = false, audit = null } = {}) {
  const now = Date.now();
  const { endorsements, fetchedAt, failedAt } = endorsementCache;
  const age = now - fetchedAt;
  const usable = Boolean(endorsements) && age <= MAX_STALE_MS;
  if (!force && endorsements && age < SOLO_ENDORSEMENT_CACHE_MS) return endorsements;
  if (!force && now - failedAt < RETRY_AFTER_FAILURE_MS) {
    if (usable) return endorsements;
    throw new Error('Endorsement list unavailable; waiting before retrying');
  }

  try {
    const [solo, s1] = await Promise.all([
      http.get(SOLO_ENDORSEMENTS_URL),
      http.get(S1_SOLO_ENDORSEMENTS_URL)
    ]);
    endorsementCache = {
      fetchedAt: now,
      failedAt: 0,
      endorsements: [
        ...parseApprovedSoloEndorsements(solo.data),
        ...parseS1SoloEndorsements(s1.data)
      ]
    };
    return endorsementCache.endorsements;
  } catch (err) {
    endorsementCache = { ...endorsementCache, failedAt: now };
    if (usable) {
      const ageHours = Math.round(age / (60 * 60 * 1000));
      log('warn', 'endorsements_using_cache', { ageHours, error: err });
      await audit?.({ action: 'Using Older Endorsement List', actorLabel: 'System', reason: `Download failed (${err.message}). Using the list from ${ageHours} hours ago.`, color: '#FF9900' });
      return endorsements;
    }
    log('error', 'endorsement_overrides_suspended', { error: err });
    await audit?.({ action: 'Endorsement Overrides Suspended', actorLabel: 'System', reason: `Download failed (${err.message}) and there is no list from the last 24 hours, so bookings need mentor approval.`, color: '#D9534F' });
    throw err;
  }
}

function buildOverrideAuditEntry(endorsement, userId, booking) {
  return {
    action: 'Endorsement Override Used',
    actorLabel: 'System',
    targetUserId: userId,
    booking,
    reason: `${formatEndorsementScope(endorsement)} (expires ${endorsement.endDate}) lets this booking skip mentor approval`,
    color: '#5865F2'
  };
}

function getBookingStartNz(dateStr, startTime) {
  const nowNz = DateTime.now().setZone(NZ_ZONE);
  let startNz = buildNzDateTime(dateStr, startTime, nowNz.year);
  if (!startNz) return nowNz;
  if (startNz < nowNz.minus({ days: 180 })) startNz = startNz.plus({ years: 1 });
  return startNz;
}

function endorsementCoversDate(endorsement, dateNz) {
  const day = dateNz.setZone(NZ_ZONE).startOf('day');
  const start = endorsement.startDateISO ? DateTime.fromISO(endorsement.startDateISO, { zone: NZ_ZONE }).startOf('day') : null;
  const end = DateTime.fromISO(endorsement.endDateISO, { zone: NZ_ZONE }).startOf('day');

  if (start?.isValid && day < start) return false;
  return end.isValid && day <= end;
}

function positionParts(position) {
  const match = String(position || '').toUpperCase().match(/^([A-Z]{4})_(DEL|GND|TWR|APP|CTR|DEP|FSS)$/);
  if (!match) return null;
  return { location: match[1], suffix: match[2] };
}

function endorsementMatchesPosition(endorsement, position, member) {
  const upper = String(position || '').toUpperCase();
  if (endorsement.source === 'solo') {
    return endorsement.positions.includes(upper);
  }

  if (endorsement.source === 's1_622') {
    if (getControllerTier(member) !== 'S1') return false;
    const parts = positionParts(upper);
    return Boolean(parts && endorsement.locations.includes(parts.location) && endorsement.positions.includes(parts.suffix));
  }

  return false;
}

function daysUntilEnd(endorsement, nowNz = DateTime.now().setZone(NZ_ZONE)) {
  const end = DateTime.fromISO(endorsement.endDateISO, { zone: NZ_ZONE }).startOf('day');
  if (!end.isValid) return null;
  return Math.floor(end.diff(nowNz.startOf('day'), 'days').days);
}

function formatEndorsementScope(endorsement) {
  if (endorsement.source === 's1_622') {
    return `${endorsement.locations.join(', ')} ${endorsement.positions.join(', ')}`;
  }
  return endorsement.position;
}

function buildSoloNotice(endorsement) {
  return `Solo endorsement applied: ${formatEndorsementScope(endorsement)} (expires ${endorsement.endDate}).`;
}

function buildExpiryWarning(endorsement, nowNz = DateTime.now().setZone(NZ_ZONE)) {
  const days = daysUntilEnd(endorsement, nowNz);
  if (!ENDORSEMENT_WARNING_DAYS.includes(days)) return null;

  if (days === 0) {
    return `Warning: your solo endorsement for ${formatEndorsementScope(endorsement)} expires today (${endorsement.endDate}).`;
  }

  if (days === 1) {
    return `Warning: your solo endorsement for ${formatEndorsementScope(endorsement)} expires tomorrow (${endorsement.endDate}).`;
  }

  return `Warning: your solo endorsement for ${formatEndorsementScope(endorsement)} expires in ${days} days (${endorsement.endDate}).`;
}

async function findMatchingSoloEndorsement({ cid, member, position, bookingDateNz, audit }) {
  const endorsements = await fetchSoloEndorsements({ audit });
  return endorsements.find(endorsement =>
    endorsement.cid === String(cid) &&
    endorsementMatchesPosition(endorsement, position, member) &&
    endorsementCoversDate(endorsement, bookingDateNz)
  ) || null;
}

async function applySoloEndorsementOverride({ baseEligibility, cid, member, position, bookingDateNz, audit = null }) {
  if (baseEligibility.allowed && baseEligibility.mentorRequired === false) {
    return { ...baseEligibility, soloEndorsement: null };
  }

  let endorsement = null;
  try {
    endorsement = await findMatchingSoloEndorsement({ cid, member, position, bookingDateNz, audit });
  } catch (err) {
    log('warn', 'endorsements_verify_failed', { error: err });
  }

  if (!endorsement) return { ...baseEligibility, soloEndorsement: null };

  return {
    allowed: true,
    mentorRequired: false,
    soloEndorsement: endorsement,
    reason: null
  };
}

function endorsementWarningKey(userId, endorsement, days) {
  return [
    userId,
    endorsement.cid,
    endorsement.source,
    formatEndorsementScope(endorsement).replace(/\s+/g, '_'),
    endorsement.endDateISO,
    days
  ].join(':');
}

function createEndorsementWarningService({ client, messages, endorsementWarnings, getVatsimId, sendAuditLog = null }) {
  let warningInterval = null;

  async function sendDueEndorsementWarnings() {
    const ownerIds = [...new Set(messages.all()
      .filter(entry => Array.isArray(entry.data) && entry.data.length > 0)
      .map(entry => String(entry.key)))];
    if (ownerIds.length === 0) return;

    let endorsements;
    try {
      endorsements = await fetchSoloEndorsements({ audit: sendAuditLog });
    } catch (err) {
      log('warn', 'endorsements_fetch_failed', { purpose: 'expiry_warnings', error: err });
      return;
    }

    for (const ownerId of ownerIds) {
      const cid = await getVatsimId(ownerId);
      if (!cid) continue;

      const matching = endorsements.filter(endorsement => endorsement.cid === String(cid));
      if (matching.length === 0) continue;

      for (const endorsement of matching) {
        const days = daysUntilEnd(endorsement);
        if (!ENDORSEMENT_WARNING_DAYS.includes(days)) continue;

        const key = endorsementWarningKey(ownerId, endorsement, days);
        if (endorsementWarnings.get(key)) continue;

        try {
          const user = await client.users.fetch(ownerId);
          await user.send({
            content: buildExpiryWarning(endorsement) || `Your solo endorsement for ${formatEndorsementScope(endorsement)} expires on ${endorsement.endDate}.`
          });
          endorsementWarnings.set(key, {
            sentAt: new Date().toISOString(),
            daysUntilExpiry: days,
            endorsement: formatEndorsementScope(endorsement)
          });
        } catch (err) {
          log('warn', 'dm_failed', { userId: ownerId, reason: 'endorsement_expiry_warning', error: err });
        }
      }
    }
  }

  function startEndorsementWarningScheduler() {
    if (warningInterval) return;
    sendDueEndorsementWarnings().catch(err => log('warn', 'endorsement_warning_check_failed', { error: err }));
    warningInterval = setInterval(() => {
      sendDueEndorsementWarnings().catch(err => log('warn', 'endorsement_warning_check_failed', { error: err }));
    }, ENDORSEMENT_WARNING_CHECK_MS);
  }

  return {
    sendDueEndorsementWarnings,
    startEndorsementWarningScheduler
  };
}

module.exports = {
  parseNzDate,
  parseApprovedSoloEndorsements,
  parseS1SoloEndorsements,
  fetchSoloEndorsements,
  getBookingStartNz,
  endorsementCoversDate,
  endorsementMatchesPosition,
  daysUntilEnd,
  formatEndorsementScope,
  buildSoloNotice,
  buildExpiryWarning,
  findMatchingSoloEndorsement,
  applySoloEndorsementOverride,
  buildOverrideAuditEntry,
  createEndorsementWarningService
};
