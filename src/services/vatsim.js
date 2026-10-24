const http = require('../utils/http');
const { log } = require('../utils/log');

const VATSIM_ID_CACHE_MS = 12 * 60 * 60 * 1000;
// Only found IDs are cached, so a controller who links their account is picked up on the next lookup.
const vatsimIdCache = new Map();

async function getVatsimId(discordId) {
  const cached = vatsimIdCache.get(discordId);
  if (cached && Date.now() - cached.at < VATSIM_ID_CACHE_MS) return cached.cid;

  try {
    const url = `https://api.vatsim.net/v2/members/discord/${encodeURIComponent(discordId)}`;
    const response = await http.get(url);

    if (!response.data || !response.data.user_id) {
      log('warn', 'vatsim_id_not_found', { discordId });
      return null;
    }

    vatsimIdCache.set(discordId, { cid: response.data.user_id, at: Date.now() });
    return response.data.user_id;
  } catch (error) {
    log('error', 'vatsim_id_lookup_failed', { discordId, error });
    return null;
  }
}

/*
// VATSIM ATC booking integration: kept inactive until API access is available.
// Configure the issued authentication and replace division/subdivision before enabling.
async function sendBooking({ callsign, cid, start, end }) {
  try {
    const payload = {
      callsign,
      cid,
      type: 'booking',
      start,
      end,
      division: 'TBC',
      subdivision: 'TBC'
    };
    const response = await axios.post('https://atc-bookings.vatsim.net/api/booking', payload);
    return response.data.id;
  } catch (error) {
    log('error', 'vatsim_booking_failed', { callsign, error });
    return null;
  }
}

async function deleteVatsimBooking(bookingId) {
  try {
    await axios.delete(`https://atc-bookings.vatsim.net/api/booking/${bookingId}`);
  } catch (error) {
    log('error', 'vatsim_booking_delete_failed', { bookingId, error });
  }
}
*/

module.exports = {
  getVatsimId
  // , sendBooking, deleteVatsimBooking
};
