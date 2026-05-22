const cheerio = require('cheerio');
const axios = require('axios');

const { sectorAerodromeMap, sectorCodeMap } = require('../constants');
const { buildUtcWindowFromNz, hhmmToClock } = require('../utils/time');

const trafficCache = new Map();

function resolveAerodromes(position) {
  if (sectorAerodromeMap[position]) return sectorAerodromeMap[position];
  const match = position.match(/^([A-Z]{4})_(APP|TWR|GND|DEL)$/);
  if (match) return [match[1]];
  return [];
}

async function getTrafficData(icao, date, start = '0000', end = '2359') {
  const utcWindow = buildUtcWindowFromNz(date, start, end);
  if (!utcWindow) {
    return { icao, arrivals: 0, departures: 0 };
  }

  const { fromUtc, toUtc } = utcWindow;
  const key = `${icao}_${fromUtc}_${toUtc}`;
  if (trafficCache.has(key)) return trafficCache.get(key);

  const url = `https://statsim.net/events/custom/${encodeURIComponent(fromUtc)}/${encodeURIComponent(toUtc)}/${icao}`;
  const { data: html } = await axios.get(url);
  const $ = cheerio.load(html);
  const text = $('body').text();

  const arrivals = parseInt(text.match(/Arrivals:\s*(\d+)/)?.[1] || 0);
  const departures = parseInt(text.match(/Departures:\s*(\d+)/)?.[1] || 0);
  const result = { icao, arrivals, departures };

  trafficCache.set(key, result);
  return result;
}

async function getSectorTraffic(sector, date, start = '0000', end = '2359') {
  const aerodromes = sectorAerodromeMap[sector] || [];

  const promises = aerodromes.map(icao =>
    getTrafficData(icao, date, start, end).catch(() => ({ arrivals: 0, departures: 0 }))
  );

  const results = await Promise.all(promises);

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
  const aerodromes = resolveAerodromes(position);

  const promises = aerodromes.map(icao =>
    getTrafficData(icao, date, start, end).catch(() => ({ icao, arrivals: 0, departures: 0 }))
  );

  const results = await Promise.all(promises);

  let out = `\u{1F4CA} **Expected Traffic (based on ${date} ${hhmmToClock(start)}-${hhmmToClock(end)})**\n`;

  for (const r of results) {
    out += `\u2022 **${r.icao}** \u2014 ${r.arrivals} arrivals / ${r.departures} departures\n`;
  }

  return out;
}

async function formatSectorTraffic(sectors, date, start = '0000', end = '2359') {
  let out = `\u{1F4CA} **Expected Traffic (based on ${date} ${hhmmToClock(start)}-${hhmmToClock(end)})**\n`;
  for (const sector of sectors) {
    const t = await getSectorTraffic(sector, date, start, end);
    out += `\u2022 **${t.sectorCode}** \u2014 ${t.total} movements (${t.arrivals} arrivals / ${t.departures} departures)\n`;
  }
  return out;
}

module.exports = {
  resolveAerodromes,
  getTrafficData,
  getSectorTraffic,
  formatAerodromeTraffic,
  formatSectorTraffic
};
