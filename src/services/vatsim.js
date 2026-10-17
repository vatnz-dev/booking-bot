const axios = require('axios');

async function getVatsimId(discordId) {
  try {
    const url = `https://api.vatsim.net/v2/members/discord/${discordId}`;
    const response = await axios.get(url);

    if (!response.data || !response.data.user_id) {
      console.error('\u274C VATSIM ID not found in response.');
      return null;
    }

    return response.data.user_id;
  } catch (error) {
    console.error('\u274C Failed to fetch VATSIM ID:', error.response?.status || error.message);
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
    console.error('VATSIM booking failed:', error.response?.status || error.message);
    return null;
  }
}

async function deleteVatsimBooking(bookingId) {
  try {
    await axios.delete(`https://atc-bookings.vatsim.net/api/booking/${bookingId}`);
  } catch (error) {
    console.error(`Failed to delete VATSIM booking ${bookingId}:`, error.response?.status || error.message);
  }
}
*/

module.exports = {
  getVatsimId
  // , sendBooking, deleteVatsimBooking
};
