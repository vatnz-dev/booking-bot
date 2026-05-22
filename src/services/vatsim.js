const axios = require('axios');

async function getVatsimId(discordId) {
  try {
    const url = `https://api.vatsim.net/v2/members/discord/${discordId}`;
    const response = await axios.get(url);

    if (!response.data || !response.data.user_id) {
      console.error('âŒ VATSIM ID not found in response.');
      return null;
    }

    return response.data.user_id;
  } catch (error) {
    console.error('âŒ Failed to fetch VATSIM ID:', error.response?.status || error.message);
    return null;
  }
}

module.exports = {
  getVatsimId
};
