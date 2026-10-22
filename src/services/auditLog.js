const fs = require('fs');
const { EmbedBuilder } = require('discord.js');

const { log } = require('../utils/log');

const { cleanEmbedValue } = require('../utils/format');
const {
  formatBookingDateForDiscord,
  formatBookingEndForDiscord,
  formatBookingStartForDiscord
} = require('../utils/time');

function formatAuditUser(userId, fallback = 'System') {
  return userId ? `<@${userId}> (${userId})` : fallback;
}

function addAuditField(fields, name, value, inline = false) {
  if (value === undefined || value === null || value === '') return;
  fields.push({ name, value: cleanEmbedValue(value), inline });
}

function createAuditLogger({ getLogChannel, getBookingMessageLink, auditFilePath = null }) {
  // The local file is the master record; the log channel is a copy that admins can delete.
  function appendAuditFile(entry) {
    if (!auditFilePath) return;
    try {
      fs.appendFileSync(auditFilePath, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
    } catch (error) {
      log('error', 'audit_file_write_failed', { action: entry.action, error });
    }
  }

  async function sendAuditLog({ action, actorId = null, actorLabel = null, targetUserId = null, booking = null, reason = null, fields = [], color = '#2F3136' }) {
    appendAuditFile({ action, actorId, actorLabel, targetUserId, reason, fields, booking });

    const logChannel = await getLogChannel();
    if (!logChannel?.send) {
      appendAuditFile({ action: 'Log Channel Post Failed', originalAction: action, error: 'Log channel not found' });
      return;
    }

    const embedFields = [];
    addAuditField(embedFields, 'Actor', actorLabel || formatAuditUser(actorId), true);
    if (targetUserId) addAuditField(embedFields, 'Controller', formatAuditUser(targetUserId), true);
    if (reason) addAuditField(embedFields, 'Reason', reason, false);

    if (booking) {
      addAuditField(embedFields, 'Position', booking.position, true);
      addAuditField(embedFields, 'Date', formatBookingDateForDiscord(booking) || booking.date, true);
      addAuditField(
        embedFields,
        'Time',
        `${formatBookingStartForDiscord(booking) || String(booking.start).padStart(4, '0')}-${formatBookingEndForDiscord(booking) || String(booking.end).padStart(4, '0')}`,
        true
      );
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
      log('error', 'audit_post_failed', { action, error: err });
      appendAuditFile({ action: 'Log Channel Post Failed', originalAction: action, error: err?.message || String(err) });
    }
  }

  return {
    sendAuditLog
  };
}

module.exports = {
  createAuditLogger
};
