const axios = require('axios');
const cheerio = require('cheerio');

const {
  ENDORSEMENT_WARNING_CHECK_MS,
  ENDORSEMENT_WARNING_DAYS,
  S1_SOLO_ENDORSEMENTS_URL,
  SOLO_ENDORSEMENT_CACHE_MS,
  SOLO_ENDORSEMENTS_URL
} = require('../constants');
const { DateTime, buildNzDateTime } = require('../utils/time');
const { summarizeError } = require('../utils/format');
const { getControllerTier } = require('./positions');

const NZ_ZONE = 'Pacific/Auckland';

let endorsementCache = {
  fetchedAt: 0,
  endorsements: []
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

function parseApprovedSoloEndorsements(html) {
  const $ = cheerio.load(html);
  const endorsements = [];

  $('table').each((_, table) => {
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

  $('table').each((_, table) => {
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

async function fetchSoloEndorsements({ force = false } = {}) {
  const now = Date.now();
  if (!force && endorsementCache.endorsements.length > 0 && now - endorsementCache.fetchedAt < SOLO_ENDORSEMENT_CACHE_MS) {
    return endorsementCache.endorsements;
  }

  try {
    const [solo, s1] = await Promise.all([
      axios.get(SOLO_ENDORSEMENTS_URL, { timeout: 15000 }),
      axios.get(S1_SOLO_ENDORSEMENTS_URL, { timeout: 15000 })
    ]);

    endorsementCache = {
      fetchedAt: now,
      endorsements: [
        ...parseApprovedSoloEndorsements(solo.data),
        ...parseS1SoloEndorsements(s1.data)
      ]
    };
  } catch (err) {
    if (endorsementCache.endorsements.length > 0) {
      console.warn(`Using cached VATNZ solo endorsements after fetch failed: ${summarizeError(err)}`);
      return endorsementCache.endorsements;
    }
    throw err;
  }

  return endorsementCache.endorsements;
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

async function findMatchingSoloEndorsement({ cid, member, position, bookingDateNz }) {
  const endorsements = await fetchSoloEndorsements();
  return endorsements.find(endorsement =>
    endorsement.cid === String(cid) &&
    endorsementMatchesPosition(endorsement, position, member) &&
    endorsementCoversDate(endorsement, bookingDateNz)
  ) || null;
}

async function applySoloEndorsementOverride({ baseEligibility, cid, member, position, bookingDateNz }) {
  if (baseEligibility.allowed && baseEligibility.mentorRequired === false) {
    return { ...baseEligibility, soloEndorsement: null };
  }

  let endorsement = null;
  try {
    endorsement = await findMatchingSoloEndorsement({ cid, member, position, bookingDateNz });
  } catch (err) {
    console.warn(`Could not verify VATNZ solo endorsements: ${summarizeError(err)}`);
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

function createEndorsementWarningService({ client, messages, endorsementWarnings, getVatsimId }) {
  let warningInterval = null;

  async function sendDueEndorsementWarnings() {
    const ownerIds = [...new Set(messages.all()
      .filter(entry => Array.isArray(entry.data) && entry.data.length > 0)
      .map(entry => String(entry.key)))];
    if (ownerIds.length === 0) return;

    let endorsements;
    try {
      endorsements = await fetchSoloEndorsements();
    } catch (err) {
      console.warn(`Could not fetch VATNZ solo endorsements for warnings: ${summarizeError(err)}`);
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
          console.warn(`Could not send solo endorsement expiry warning to ${ownerId}:`, err?.message || err);
        }
      }
    }
  }

  function startEndorsementWarningScheduler() {
    if (warningInterval) return;
    sendDueEndorsementWarnings().catch(err => console.warn('Solo endorsement warning check failed:', err?.message || err));
    warningInterval = setInterval(() => {
      sendDueEndorsementWarnings().catch(err => console.warn('Solo endorsement warning check failed:', err?.message || err));
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
  createEndorsementWarningService
};
