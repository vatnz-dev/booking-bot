const http = require('../utils/http');
const { log } = require('../utils/log');

async function getVatsimId(discordId) {
  try {
    const url = `https://api.vatsim.net/v2/members/discord/${discordId}`;
    const response = await http.get(url);

    if (!response.data || !response.data.user_id) {
      log('warn', 'vatsim_id_not_found', { discordId });
      return null;
    }

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
