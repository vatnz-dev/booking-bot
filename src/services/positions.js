const cheerio = require('cheerio');
const http = require('../utils/http');

const {
  ratingRoleIds,
  FALLBACK_EVENT_POSITIONS,
  VATNZ_POSITIONS_URL,
  VATNZ_POSITION_CACHE_MS
} = require('../constants');
const { log } = require('../utils/log');

let vatnzPositionCache = {
  fetchedAt: 0,
  positions: new Map()
};

function getControllerTier(member) {
  for (const rating of ['I3', 'I1', 'C3', 'C1', 'S3', 'S2', 'S1']) {
    if (ratingRoleIds[rating] && member.roles.cache.has(ratingRoleIds[rating])) return rating;
  }
  return 'UNRATED';
}

function getPositionType(position) {
  if (position.endsWith('_CTR')) return 'CTR';
  if (position.endsWith('_APP')) return 'APP';
  if (/_((DEL)|(GND)|(TWR))$/.test(position)) return 'LOCAL';
  return 'OTHER';
}

function getBookablePositionSuffix(position) {
  return String(position || '').match(/_(FSS|CTR|APP|DEP|TWR|GND|DEL)$/)?.[1] || null;
}

function parseVatnzPositions(html) {
  const $ = cheerio.load(html);
  const positions = new Map();

  $('table.positions tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 4) return;

    const callsign = $(cells[0]).text().trim().toUpperCase();
    const suffix = getBookablePositionSuffix(callsign);
    if (!suffix) return;

    const rowClass = $(row).attr('class') || '';
    positions.set(callsign, {
      callsign,
      suffix,
      isEvent: rowClass.split(/\s+/).includes('position_type_E')
    });
  });

  return positions;
}

async function fetchVatnzPositions({ force = false } = {}) {
  const now = Date.now();
  if (!force && vatnzPositionCache.positions.size > 0 && now - vatnzPositionCache.fetchedAt < VATNZ_POSITION_CACHE_MS) {
    return vatnzPositionCache.positions;
  }

  try {
    const { data: html } = await http.get(VATNZ_POSITIONS_URL);
    const positions = parseVatnzPositions(html);
    if (positions.size === 0) throw new Error('VATNZ position table was empty');

    vatnzPositionCache = {
      fetchedAt: now,
      positions
    };
  } catch (err) {
    if (vatnzPositionCache.positions.size > 0) {
      log('warn', 'positions_using_cache', { error: err });
      return vatnzPositionCache.positions;
    }
    throw err;
  }

  return vatnzPositionCache.positions;
}

async function validateVatnzPosition(position) {
  let positions;
  try {
    positions = await fetchVatnzPositions();
  } catch (err) {
    log('warn', 'positions_verify_failed', { error: err });
    return {
      valid: false,
      reason: 'Could not verify the VATNZ position directory right now. Please try again shortly.'
    };
  }

  const meta = positions.get(position);
  if (!meta) {
    return {
      valid: false,
      reason: `${position} is not a bookable VATNZ position. Please use a callsign from ${VATNZ_POSITIONS_URL}`
    };
  }

  return { valid: true, meta };
}

async function validateVatnzEventPosition(position) {
  const validation = await validateVatnzPosition(position);
  if (!validation.valid) return validation;

  if (!validation.meta.isEvent) {
    return {
      valid: false,
      reason: `${position} is a standard VATNZ position, not an event-only position.`
    };
  }

  return validation;
}

async function getVatnzEventPositions() {
  try {
    const positions = await fetchVatnzPositions();
    const eventPositions = [...positions.values()]
      .filter(position => position.isEvent)
      .map(position => position.callsign);

    return eventPositions.length > 0 ? eventPositions : FALLBACK_EVENT_POSITIONS;
  } catch (err) {
    log('warn', 'event_positions_fetch_failed', { error: err });
    return FALLBACK_EVENT_POSITIONS;
  }
}

function evaluateBookingEligibility(member, position) {
  const tier = getControllerTier(member);
  const type = getPositionType(position);

  if (['C1', 'C3', 'I1', 'I3'].includes(tier)) {
    return { allowed: true, mentorRequired: false };
  }

  if (tier === 'S3') {
    if (type === 'CTR') return { allowed: true, mentorRequired: true };
    if (type === 'APP' || type === 'LOCAL') return { allowed: true, mentorRequired: false };
    return { allowed: false, reason: '\u274C S3 can only book DEL/GND/TWR/APP directly. CTR requires mentor approval.' };
  }

  if (tier === 'S2') {
    if (type === 'CTR') return { allowed: false, reason: '\u274C S2 cannot book CTR positions.' };
    if (type === 'APP') return { allowed: true, mentorRequired: true };
    if (type === 'LOCAL') return { allowed: true, mentorRequired: false };
    return { allowed: false, reason: '\u274C S2 can only book DEL/GND/TWR directly, or APP with mentor approval.' };
  }

  if (tier === 'S1' || tier === 'UNRATED') {
    if (type === 'CTR') return { allowed: false, reason: '\u274C S1/unrated controllers cannot book CTR positions.' };
    if (type === 'APP') return { allowed: false, reason: '\u274C S1/unrated controllers cannot book APP positions.' };
    if (type === 'LOCAL') return { allowed: true, mentorRequired: true };
    return { allowed: false, reason: '\u274C S1/unrated controllers can only book DEL/GND/TWR with mentor approval.' };
  }

  return { allowed: false, reason: '\u274C Could not determine your booking permissions.' };
}

module.exports = {
  getControllerTier,
  getPositionType,
  getBookablePositionSuffix,
  parseVatnzPositions,
  fetchVatnzPositions,
  validateVatnzPosition,
  validateVatnzEventPosition,
  getVatnzEventPositions,
  evaluateBookingEligibility
};
