const cheerio = require('cheerio');
const axios = require('axios');

const { settings } = require('../data/databases');
const { sectorAerodromeMap, sectorCodeMap } = require('../constants');
const { DateTime, NZ_ZONE, buildUtcWindowFromNz, hhmmToClock } = require('../utils/time');

const trafficCache = new Map();
const STATSIM_BASE_URL = 'https://statsim.net';
const DEFAULT_STATSIM_TIMEOUT_MS = 15000;
const DEFAULT_ZERO_FALLBACK_YEARS = 3;
const STATSIM_SETTING_KEY = 'statsim';
const STATSIM_DISABLED_MESSAGE = 'No StatSim data available at the moment due to server/bot errors.';
let healthCheckPromise = null;
let healthCheckTimer = null;
let stateRevision = 0;

function resolveAerodromes(position) {
  if (sectorAerodromeMap[position]) return sectorAerodromeMap[position];
  const match = position.match(/^([A-Z]{4})_(APP|TWR|GND|DEL)$/);
  if (match) return [match[1]];
  return [];
}

async function getTrafficData(icao, date, start = '0000', end = '2359') {
  if (!isStatsimEnabled()) {
    const err = new Error(STATSIM_DISABLED_MESSAGE);
    err.code = 'STATSIM_DISABLED';
    throw err;
  }

  const utcWindow = buildUtcWindowFromNz(date, start, end);
  if (!utcWindow) {
    return { icao, arrivals: 0, departures: 0 };
  }

  const { fromUtc, toUtc } = utcWindow;
  const key = `${icao}_${fromUtc}_${toUtc}`;
  if (trafficCache.has(key)) return trafficCache.get(key);

  let counts;
  const revision = stateRevision;
  try {
    counts = await fetchStatsimTraffic(icao, fromUtc, toUtc);
  } catch (error) {
    markStatsimUnavailable(error, revision);
    throw error;
  }
  const result = { icao, ...counts, statsimDate: date, requestedDate: date };
  trafficCache.set(key, result);
  return result;
}

async function fetchStatsimTraffic(icao, fromUtc, toUtc) {
  const url = `${STATSIM_BASE_URL}/events/custom/${encodeURIComponent(fromUtc)}/${encodeURIComponent(toUtc)}/${encodeURIComponent(icao)}`;
  const { data: html } = await axios.get(url, {
    timeout: getStatsimTimeoutMs(),
    headers: {
      'User-Agent': 'VATNZ-Booking-Bot/1.0 (+https://github.com/vatnz-dev/booking-bot)'
    }
  });

  return parseStatsimTrafficHtml(html, icao);
}

function getStatsimTimeoutMs() {
  const configured = Number.parseInt(process.env.STATSIM_TIMEOUT_MS || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STATSIM_TIMEOUT_MS;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalised = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on', 'enable', 'enabled'].includes(normalised)) return true;
  if (['false', '0', 'no', 'n', 'off', 'disable', 'disabled'].includes(normalised)) return false;
  return fallback;
}

function getEnvStatsimEnabled() {
  return parseBoolean(process.env.STATSIM_ENABLED, true);
}

function getStatsimState() {
  const stored = settings.get(STATSIM_SETTING_KEY);
  if (stored && typeof stored === 'object' && typeof stored.enabled === 'boolean') {
    return {
      enabled: stored.enabled,
      autoDisabled: stored.autoDisabled === true,
      reason: stored.reason || null,
      updatedAt: stored.updatedAt || null,
      updatedBy: stored.updatedBy || null,
      source: 'settings'
    };
  }

  return {
    enabled: getEnvStatsimEnabled(),
    autoDisabled: false,
    reason: null,
    updatedAt: null,
    updatedBy: null,
    source: 'env'
  };
}

function isStatsimEnabled() {
  return getStatsimState().enabled;
}

function setStatsimEnabled(enabled, { actorId = null, reason = null, autoDisabled = false } = {}) {
  const state = {
    enabled: Boolean(enabled),
    autoDisabled: !enabled && autoDisabled,
    reason: reason ? String(reason).trim().slice(0, 250) : null,
    updatedAt: new Date().toISOString(),
    updatedBy: actorId ? String(actorId) : null
  };

  settings.set(STATSIM_SETTING_KEY, state);
  stateRevision += 1;
  if (state.enabled) trafficCache.clear();
  return getStatsimState();
}

function markStatsimUnavailable(error, revision = stateRevision) {
  if (revision !== stateRevision || !getStatsimState().enabled) return;
  setStatsimEnabled(false, { autoDisabled: true, reason: error?.message || 'StatSim lookup failed' });
  console.warn('StatSim automatically disabled; recovery checks will continue.');
}

function getStatsimHealthCheckMs() {
  const minutes = Number(process.env.STATSIM_HEALTH_CHECK_MINUTES || 5);
  return (Number.isFinite(minutes) && minutes >= 1 ? minutes : 5) * 60000;
}

async function checkStatsimHealth() {
  if (healthCheckPromise) return healthCheckPromise;
  const state = getStatsimState();
  if (!state.enabled && !state.autoDisabled) return false;
  const revision = stateRevision;
  healthCheckPromise = (async () => {
    try {
      const date = DateTime.now().setZone(NZ_ZONE).minus({ days: 7 }).toISODate();
      const { fromUtc, toUtc } = buildUtcWindowFromNz(date);
      // Always probe the real traffic endpoint without using cached results.
      await fetchStatsimTraffic('NZAA', fromUtc, toUtc);
      const current = getStatsimState();
      if (current.autoDisabled && revision === stateRevision) {
        setStatsimEnabled(true, { reason: 'StatSim recovered automatically' });
        console.log('StatSim recovered; traffic lookups automatically enabled.');
      }
      return true;
    } catch (error) {
      markStatsimUnavailable(error, revision);
      return false;
    }
  })();
  try {
    return await healthCheckPromise;
  } finally {
    healthCheckPromise = null;
  }
}

function startStatsimHealthScheduler() {
  if (healthCheckTimer) return;
  const check = () => checkStatsimHealth().catch(error => console.warn('StatSim health check failed:', error.message));
  void check();
  healthCheckTimer = setInterval(check, getStatsimHealthCheckMs());
  healthCheckTimer.unref();
}

function getZeroFallbackYears() {
  const configured = Number.parseInt(process.env.STATSIM_ZERO_FALLBACK_YEARS || '', 10);
  if (!Number.isFinite(configured)) return DEFAULT_ZERO_FALLBACK_YEARS;
  return Math.max(0, Math.min(configured, 10));
}

function toCount(value) {
  const count = Number.parseInt(String(value || '0').replace(/,/g, ''), 10);
  return Number.isFinite(count) ? count : 0;
}

function normaliseText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseStatsimChartData(html, icao) {
  const chartMatch = String(html).match(/var\s+airportCharts\s*=\s*(\[[\s\S]*?\]);/i);
  if (!chartMatch) return null;

  try {
    const charts = JSON.parse(chartMatch[1]);
    const airport = charts.find(chart => String(chart?.icao || '').toUpperCase() === icao);
    if (!airport || !Array.isArray(airport.arrivals) || !Array.isArray(airport.departures)) return null;

    const departures = Array.isArray(airport.departures)
      ? airport.departures.reduce((sum, point) => sum + toCount(point?.y), 0)
      : 0;
    const arrivals = Array.isArray(airport.arrivals)
      ? airport.arrivals.reduce((sum, point) => sum + toCount(point?.y), 0)
      : 0;

    return { arrivals, departures };
  } catch (err) {
    console.warn(`Could not parse StatSim chart data for ${icao}:`, err?.message || err);
    return null;
  }
}

function parseStatsimCountText(html) {
  const $ = cheerio.load(html);
  const text = normaliseText($('body').text());
  const departures = text.match(/Departures:\s*([\d,]+)/i);
  const arrivals = text.match(/Arrivals:\s*([\d,]+)/i);

  if (!departures || !arrivals) return null;
  return {
    departures: toCount(departures?.[1]),
    arrivals: toCount(arrivals?.[1])
  };
}

function parseStatsimTrafficHtml(html, icao) {
  const countTraffic = parseStatsimCountText(html);
  if (countTraffic) return countTraffic;

  const chartTraffic = parseStatsimChartData(html, icao);
  if (chartTraffic) return chartTraffic;

  throw new Error(`Could not find StatSim arrivals/departures for ${icao}`);
}

function getTrafficDateCandidates(date) {
  const baseDate = DateTime.fromISO(String(date), { zone: NZ_ZONE });
  if (!baseDate.isValid) return [date];

  const dates = [baseDate.toFormat('yyyy-MM-dd')];
  const fallbackYears = getZeroFallbackYears();
  for (let year = 1; year <= fallbackYears; year += 1) {
    dates.push(baseDate.minus({ weeks: year * 52 }).toFormat('yyyy-MM-dd'));
  }

  return [...new Set(dates)];
}

async function getTrafficDataSet(aerodromes, date, start = '0000', end = '2359') {
  const results = await Promise.all(aerodromes.map(icao =>
    getTrafficData(icao, date, start, end)
      .catch(err => ({
        icao,
        arrivals: 0,
        departures: 0,
        error: err?.message || String(err),
        statsimDate: date,
        requestedDate: date
      }))
  ));

  const failures = results.filter(result => result.error);
  const total = results.reduce((sum, result) => sum + result.arrivals + result.departures, 0);

  if (failures.length > 0) {
    throw new Error(`StatSim lookups failed for ${date}: ${failures.map(result => `${result.icao}: ${result.error}`).join('; ')}`);
  }

  return { date, results, total, failures };
}

async function getBestTrafficDataSet(aerodromes, date, start = '0000', end = '2359') {
  const candidates = getTrafficDateCandidates(date);
  let lastDataSet = null;

  for (const candidateDate of candidates) {
    const dataSet = await getTrafficDataSet(aerodromes, candidateDate, start, end);
    lastDataSet = dataSet;
    if (dataSet.total > 0 || candidates.length === 1) {
      return {
        ...dataSet,
        requestedDate: date,
        usedFallback: candidateDate !== date
      };
    }
  }

  return {
    ...lastDataSet,
    requestedDate: date,
    usedFallback: lastDataSet?.date !== date
  };
}

function buildTrafficHeader(date, requestedDate, start, end) {
  let out = `\u{1F4CA} **Expected Traffic (based on ${date} ${hhmmToClock(start)}-${hhmmToClock(end)})**\n`;
  if (date !== requestedDate) {
    out += `_StatSim returned no movements for ${requestedDate}, so using the equivalent prior-year weekday ${date}._\n`;
  }
  return out;
}

async function getSectorTraffic(sector, date, start = '0000', end = '2359') {
  if (!isStatsimEnabled()) {
    const err = new Error(STATSIM_DISABLED_MESSAGE);
    err.code = 'STATSIM_DISABLED';
    throw err;
  }

  const aerodromes = sectorAerodromeMap[sector] || [];

  const { results } = await getTrafficDataSet(aerodromes, date, start, end);

  let arrivals = 0;
  let departures = 0;

  for (const r of results) {
    arrivals += r.arrivals;
    departures += r.departures;
  }

  return {
    sectorCode: sectorCodeMap[sector] || sector,
    arrivals,
    departures,
    total: arrivals + departures
  };
}

async function formatAerodromeTraffic(position, date, start = '0000', end = '2359') {
  if (!isStatsimEnabled()) return STATSIM_DISABLED_MESSAGE;

  const aerodromes = resolveAerodromes(position);
  let dataSet;
  try {
    dataSet = await getBestTrafficDataSet(aerodromes, date, start, end);
  } catch (err) {
    console.warn('StatSim aerodrome traffic lookup failed:', err?.message || err);
    return STATSIM_DISABLED_MESSAGE;
  }
  const results = dataSet.results;

  let out = buildTrafficHeader(dataSet.date, dataSet.requestedDate, start, end);

  for (const r of results) {
    out += `\u2022 **${r.icao}** \u2014 ${r.arrivals} arrivals / ${r.departures} departures\n`;
  }

  return out;
}

async function formatSectorTraffic(sectors, date, start = '0000', end = '2359') {
  if (!isStatsimEnabled()) return STATSIM_DISABLED_MESSAGE;

  const aerodromes = [...new Set(sectors.flatMap(sector => sectorAerodromeMap[sector] || []))];
  let dataSet;
  try {
    dataSet = await getBestTrafficDataSet(aerodromes, date, start, end);
  } catch (err) {
    console.warn('StatSim sector traffic lookup failed:', err?.message || err);
    return STATSIM_DISABLED_MESSAGE;
  }
  const trafficByIcao = new Map(dataSet.results.map(result => [result.icao, result]));

  let out = buildTrafficHeader(dataSet.date, dataSet.requestedDate, start, end);
  for (const sector of sectors) {
    const aerodromeTraffic = (sectorAerodromeMap[sector] || []).map(icao =>
      trafficByIcao.get(icao) || { arrivals: 0, departures: 0 }
    );
    const arrivals = aerodromeTraffic.reduce((sum, result) => sum + result.arrivals, 0);
    const departures = aerodromeTraffic.reduce((sum, result) => sum + result.departures, 0);
    const t = {
      sectorCode: sectorCodeMap[sector] || sector,
      arrivals,
      departures,
      total: arrivals + departures
    };
    out += `\u2022 **${t.sectorCode}** \u2014 ${t.total} movements (${t.arrivals} arrivals / ${t.departures} departures)\n`;
  }
  return out;
}

module.exports = {
  resolveAerodromes,
  getStatsimState,
  isStatsimEnabled,
  setStatsimEnabled,
  checkStatsimHealth,
  startStatsimHealthScheduler,
  STATSIM_DISABLED_MESSAGE,
  getTrafficData,
  getSectorTraffic,
  formatAerodromeTraffic,
  formatSectorTraffic
};
