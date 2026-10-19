const { LOG_CHANNEL_ID } = require('../constants');

function createDiscordHelpers({ client }) {
  async function fetchDiscordChannel(channelId, label = 'channel') {
    if (!channelId) return null;
    try {
      return client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
    } catch (err) {
      console.warn(`Could not fetch ${label} ${channelId}:`, err?.message || err);
      return null;
    }
  }

  async function getBookingChannel() {
    return fetchDiscordChannel(process.env.CHANNEL_ID, 'booking channel');
  }

  async function getLogChannel() {
    return fetchDiscordChannel(LOG_CHANNEL_ID, 'log channel');
  }

  async function fetchBookingMessage(booking) {
    const preferredChannelId = booking?.channelId || process.env.CHANNEL_ID;
    const preferredChannel = await fetchDiscordChannel(preferredChannelId, 'booking message channel');
    if (preferredChannel?.messages && booking?.messageId) {
      try {
        return await preferredChannel.messages.fetch(booking.messageId);
      } catch (err) {
        console.warn(`Could not fetch booking message ${booking.messageId} from ${preferredChannelId}:`, err?.message || err);
      }
    }

    if (preferredChannelId !== process.env.CHANNEL_ID) {
      const fallbackChannel = await getBookingChannel();
      if (fallbackChannel?.messages && booking?.messageId) {
        try {
          return await fallbackChannel.messages.fetch(booking.messageId);
        } catch (err) {
          console.warn(`Could not fetch booking message ${booking.messageId} from fallback channel:`, err?.message || err);
        }
      }
    }

    return null;
  }

  function getGuildIdForLinks(booking) {
    return booking?.guildId || client.guilds.cache.first()?.id || '@me';
  }

  function getBookingMessageLink(booking) {
    if (!booking?.messageId) return null;
    const channelId = booking.channelId || process.env.CHANNEL_ID;
    return `https://discord.com/channels/${getGuildIdForLinks(booking)}/${channelId}/${booking.messageId}`;
  }

  return {
    fetchDiscordChannel,
    getBookingChannel,
    getLogChannel,
    fetchBookingMessage,
    getGuildIdForLinks,
    getBookingMessageLink
  };
}

module.exports = {
  createDiscordHelpers
};
