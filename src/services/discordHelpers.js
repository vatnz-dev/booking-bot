const { LOG_CHANNEL_ID } = require('../constants');
const { log } = require('../utils/log');

function createDiscordHelpers({ client }) {
  async function fetchDiscordChannel(channelId, label = 'channel') {
    if (!channelId) return null;
    try {
      return client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
    } catch (err) {
      log('warn', 'channel_fetch_failed', { label, channelId, error: err });
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
        log('warn', 'booking_message_fetch_failed', { messageId: booking.messageId, channelId: preferredChannelId, error: err });
      }
    }

    if (preferredChannelId !== process.env.CHANNEL_ID) {
      const fallbackChannel = await getBookingChannel();
      if (fallbackChannel?.messages && booking?.messageId) {
        try {
          return await fallbackChannel.messages.fetch(booking.messageId);
        } catch (err) {
          log('warn', 'booking_message_fetch_failed', { messageId: booking.messageId, channelId: process.env.CHANNEL_ID, fallback: true, error: err });
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
