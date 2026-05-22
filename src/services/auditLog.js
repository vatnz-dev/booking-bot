const { EmbedBuilder } = require('discord.js');

const { cleanEmbedValue } = require('../utils/format');

function formatAuditUser(userId, fallback = 'System') {
  return userId ? `<@${userId}> (${userId})` : fallback;
}

function addAuditField(fields, name, value, inline = false) {
  if (value === undefined || value === null || value === '') return;
  fields.push({ name, value: cleanEmbedValue(value), inline });
}

function createAuditLogger({ getLogChannel, getBookingMessageLink }) {
  async function sendAuditLog({ action, actorId = null, actorLabel = null, targetUserId = null, booking = null, reason = null, fields = [], color = '#2F3136' }) {
    const logChannel = await getLogChannel();
    if (!logChannel?.send) return;

    const embedFields = [];
    addAuditField(embedFields, 'Actor', actorLabel || formatAuditUser(actorId), true);
    if (targetUserId) addAuditField(embedFields, 'Controller', formatAuditUser(targetUserId), true);
    if (reason) addAuditField(embedFields, 'Reason', reason, false);

    if (booking) {
      addAuditField(embedFields, 'Position', booking.position, true);
      addAuditField(embedFields, 'Date', booking.date, true);
      addAuditField(embedFields, 'Time', `${String(booking.start).padStart(4, '0')}-${String(booking.end).padStart(4, '0')}`, true);
      addAuditField(embedFields, 'Channel', `<#${booking.channelId || process.env.CHANNEL_ID}>`, true);
      if (booking.threadId) addAuditField(embedFields, 'Thread', `<#${booking.threadId}>`, true);
      const link = getBookingMessageLink(booking);
      if (link) addAuditField(embedFields, 'Message', `[Open message](${link})`, false);
    }

    for (const field of fields) {
      addAuditField(embedFields, field.name, field.value, field.inline);
    }

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(action)
      .addFields(embedFields)
      .setTimestamp();

    try {
      await logChannel.send({ embeds: [embed] });
    } catch (err) {
      console.warn('Could not send audit log:', err?.message || err);
    }
  }

  return {
    sendAuditLog
  };
}

module.exports = {
  createAuditLogger
};
