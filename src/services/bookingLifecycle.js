const { EmbedBuilder } = require('discord.js');

const {
  BOOKING_REMINDERS_ENABLED,
  BOOKING_REMINDER_MINUTES,
  MENTOR_TAG_TIMEOUT_MS,
  MENTOR_APPROVAL_TIMEOUT_MS,
  ONE_HOUR_MS,
  THUMBS_UP
} = require('../constants');
const {
  DateTime,
  buildNzDateTime,
  formatBookingWindowForDiscord,
  getBookingDisplayInterval,
  getPreviousWeekNZ,
  toDiscordTimestamp
} = require('../utils/time');
const { formatSectorTraffic } = require('./traffic');

const MAX_TIMEOUT_MS = 2_147_483_647;

function createBookingLifecycle({
  client,
  messages,
  fetchBookingMessage,
  getBookingMessageLink = () => null,
  sendAuditLog,
  refreshEventCoverageNotificationsForBooking = async () => {}
}) {
  const mentorTagTimeouts = new Map();
  const mentorApprovalTimeouts = new Map();
  const extensionSelectionTimeouts = new Map();
  const bookingReminderTimeouts = new Map();
  let bookingCleanupInterval = null;

  function clearMentorTimers(messageId) {
    const tagTimer = mentorTagTimeouts.get(messageId);
    if (tagTimer) {
      clearTimeout(tagTimer);
      mentorTagTimeouts.delete(messageId);
    }
    const approvalTimer = mentorApprovalTimeouts.get(messageId);
    if (approvalTimer) {
      clearTimeout(approvalTimer);
      mentorApprovalTimeouts.delete(messageId);
    }
  }

  function clearExtensionSelectionTimer(messageId) {
    const timer = extensionSelectionTimeouts.get(messageId);
    if (timer) {
      clearTimeout(timer);
      extensionSelectionTimeouts.delete(messageId);
    }
  }

  function clearBookingReminderTimer(messageId) {
    const timer = bookingReminderTimeouts.get(messageId);
    if (timer) {
      clearTimeout(timer);
      bookingReminderTimeouts.delete(messageId);
    }
  }

  function findBookingByMessageId(messageId) {
    const db = messages.all();
    for (const entry of db) {
      const bookings = entry.data;
      if (!Array.isArray(bookings)) continue;
      const index = bookings.findIndex(b => b.messageId === messageId);
      if (index !== -1) {
        return { ownerId: entry.key, bookings, booking: bookings[index], index };
      }
    }
    return null;
  }

  function scheduleExtensionSelectionTimeout(ownerId, messageId) {
    clearExtensionSelectionTimer(messageId);
    const timeout = setTimeout(async () => {
      const entry = findBookingByMessageId(messageId);
      if (!entry || !entry.booking) return;
      if (!entry.booking.awaitingExtensionSelection) return;

      entry.booking.awaitingExtensionSelection = false;
      messages.set(entry.ownerId, entry.bookings);
      clearExtensionSelectionTimer(messageId);

      const prevDate = getPreviousWeekNZ(entry.booking.date, entry.booking.start);
      const allSectors = [entry.booking.position, ...(entry.booking.extendedSectors || [])];
      const traffic = await formatSectorTraffic(
        allSectors,
        prevDate,
        String(entry.booking.start).padStart(4, '0'),
        String(entry.booking.end).padStart(4, '0')
      );

      try {
        const user = await client.users.fetch(ownerId);
        await user.send({
          content: `You dismissed the extension selection, so it was defaulted to no extra sectors.\n\n${traffic}`
        });
      } catch (err) {
        console.warn(`\u26A0\uFE0F Could not DM user ${ownerId} with fallback extension stats:`, err?.message || err);
      }
    }, 3 * 60 * 1000);

    extensionSelectionTimeouts.set(messageId, timeout);
  }

  async function removeBookingAndNotify({ ownerId, messageId, dmText, auditAction = 'Booking Auto-Deleted', auditReason = 'Automatic deletion' }) {
    const entry = findBookingByMessageId(messageId);
    if (!entry) return;

    const removedBooking = { ...entry.booking };
    entry.bookings.splice(entry.index, 1);
    messages.set(entry.ownerId, entry.bookings);
    clearMentorTimers(messageId);
    clearExtensionSelectionTimer(messageId);
    clearBookingReminderTimer(messageId);
    await refreshEventCoverageNotificationsForBooking(removedBooking);

    try {
      const msg = await fetchBookingMessage(removedBooking);
      if (msg) await msg.delete();
    } catch (err) {
      console.warn(`\u26A0\uFE0F Could not auto-delete booking message ${messageId}:`, err?.message || err);
    }

    if (dmText) {
      try {
        const user = await client.users.fetch(entry.ownerId);
        await user.send({ content: dmText });
      } catch (err) {
        console.warn(`\u26A0\uFE0F Could not DM user ${ownerId} about auto-deletion:`, err?.message || err);
      }
    }

    await sendAuditLog({
      action: auditAction,
      actorLabel: 'System',
      targetUserId: entry.ownerId,
      booking: removedBooking,
      reason: auditReason,
      color: '#D9534F'
    });
  }

  function scheduleMentorTagTimeout(ownerId, messageId, delayMs = MENTOR_TAG_TIMEOUT_MS) {
    clearMentorTimers(messageId);
    const timeout = setTimeout(async () => {
      const entry = findBookingByMessageId(messageId);
      if (!entry || !entry.booking.mentorRequired) return;
      if (entry.booking.mentorId) return;
      await removeBookingAndNotify({
        ownerId,
        messageId,
        dmText: 'Your booking was auto-deleted because you did not tag a mentor within 5 minutes. Please rebook and tag your mentor promptly.',
        auditAction: 'Mentor Tag Timeout Auto-Delete',
        auditReason: 'Controller did not tag a mentor within 5 minutes'
      });
    }, Math.max(1000, delayMs));
    mentorTagTimeouts.set(messageId, timeout);
  }

  function scheduleMentorApprovalTimeout(ownerId, messageId, delayMs = MENTOR_APPROVAL_TIMEOUT_MS) {
    const existing = mentorApprovalTimeouts.get(messageId);
    if (existing) clearTimeout(existing);

    const timeout = setTimeout(async () => {
      const entry = findBookingByMessageId(messageId);
      if (!entry || !entry.booking.mentorRequired) return;
      if (entry.booking.mentorApproved) return;
      await removeBookingAndNotify({
        ownerId,
        messageId,
        dmText: `Your booking was auto-deleted because your mentor did not approve with a ${THUMBS_UP} within 30 minutes. Please rebook and get your mentor to approve.`,
        auditAction: 'Mentor Approval Timeout Auto-Delete',
        auditReason: 'Mentor did not approve within 30 minutes'
      });
    }, Math.max(1000, delayMs));
    mentorApprovalTimeouts.set(messageId, timeout);
  }

  function remainingFromTimestamp(timestamp, timeoutMs) {
    const created = DateTime.fromISO(timestamp || '');
    if (!created.isValid) return timeoutMs;
    return created.plus({ milliseconds: timeoutMs }).diffNow().milliseconds;
  }

  function rescheduleMentorTimers(ownerId, booking) {
    if (!booking?.mentorRequired || booking.mentorApproved) return;

    if (!booking.mentorId) {
      scheduleMentorTagTimeout(ownerId, booking.messageId, remainingFromTimestamp(booking.mentorTagRequestedAt || booking.createdAt, MENTOR_TAG_TIMEOUT_MS));
      return;
    }

    scheduleMentorApprovalTimeout(ownerId, booking.messageId, remainingFromTimestamp(booking.mentorTaggedAt, MENTOR_APPROVAL_TIMEOUT_MS));
  }

  async function sendBookingReminder(ownerId, messageId) {
    const entry = findBookingByMessageId(messageId);
    if (!entry?.booking || entry.booking.reminderSentAt) return;

    const interval = getBookingDisplayInterval(entry.booking);
    const nowUtc = DateTime.now().toUTC();
    if (!interval || interval.startUtc <= nowUtc) return;

    const messageLink = getBookingMessageLink(entry.booking);
    const fields = [
      { name: 'Position', value: entry.booking.position || 'Booking', inline: true },
      { name: 'Time', value: formatBookingWindowForDiscord(entry.booking) || `${entry.booking.date} ${entry.booking.start}-${entry.booking.end}`, inline: false }
    ];
    if (messageLink) {
      fields.push({ name: 'Booking', value: `[Open booking](${messageLink})`, inline: false });
    }

    try {
      const user = await client.users.fetch(ownerId);
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setColor('#00AEFF')
            .setTitle('Booking Reminder')
            .setDescription(`Your **${entry.booking.position}** booking starts ${toDiscordTimestamp(interval.startUtc, 'R')}.`)
            .addFields(fields)
            .setTimestamp()
        ]
      });

      entry.booking.reminderSentAt = new Date().toISOString();
      entry.booking.reminderMinutes = BOOKING_REMINDER_MINUTES;
      messages.set(entry.ownerId, entry.bookings);
      await sendAuditLog({
        action: 'Booking Reminder Sent',
        actorLabel: 'System',
        targetUserId: entry.ownerId,
        booking: entry.booking,
        reason: `${BOOKING_REMINDER_MINUTES}-minute reminder`,
        color: '#00AEFF'
      });
    } catch (err) {
      console.warn(`Could not send booking reminder to ${ownerId}:`, err?.message || err);
    } finally {
      clearBookingReminderTimer(messageId);
    }
  }

  function scheduleBookingReminder(ownerId, booking) {
    clearBookingReminderTimer(booking?.messageId);
    if (!BOOKING_REMINDERS_ENABLED || !booking?.messageId || booking.reminderSentAt) return;

    const interval = getBookingDisplayInterval(booking);
    if (!interval) return;

    const nowUtc = DateTime.now().toUTC();
    if (interval.startUtc <= nowUtc) return;

    const reminderAt = interval.startUtc.minus({ minutes: BOOKING_REMINDER_MINUTES });
    const delayMs = Math.max(1000, reminderAt.diff(nowUtc).milliseconds);
    const cappedDelayMs = Math.min(delayMs, MAX_TIMEOUT_MS);

    const timeout = setTimeout(() => {
      if (delayMs > MAX_TIMEOUT_MS) {
        const entry = findBookingByMessageId(booking.messageId);
        if (entry?.booking) scheduleBookingReminder(entry.ownerId, entry.booking);
        return;
      }

      sendBookingReminder(ownerId, booking.messageId).catch(err => {
        console.warn('Booking reminder failed:', err?.message || err);
      });
    }, cappedDelayMs);

    bookingReminderTimeouts.set(booking.messageId, timeout);
  }

  function rescheduleBookingReminder(ownerId, booking) {
    scheduleBookingReminder(ownerId, booking);
  }

  function rescheduleAllBookingReminders() {
    for (const entry of messages.all()) {
      const ownerId = String(entry.key);
      const bookings = entry.data;
      if (!Array.isArray(bookings)) continue;

      for (const booking of bookings) {
        rescheduleBookingReminder(ownerId, booking);
        rescheduleMentorTimers(ownerId, booking);
      }
    }
  }

  async function handleMentorApprovalReaction(reaction, user) {
    try {
      if (user.bot) return;
      if (reaction.partial) await reaction.fetch();
      if (reaction.message?.partial) await reaction.message.fetch();
      if (reaction.emoji?.name !== THUMBS_UP) return;

      const messageId = reaction.message.id;
      const entry = findBookingByMessageId(messageId);
      if (!entry) return;
      const booking = entry.booking;
      if (!booking.mentorRequired || !booking.mentorId || booking.mentorApproved) return;
      if (user.id !== booking.mentorId) return;

      booking.mentorApproved = true;
      booking.mentorApprovedAt = new Date().toISOString();
      messages.set(entry.ownerId, entry.bookings);

      const approvalTimer = mentorApprovalTimeouts.get(messageId);
      if (approvalTimer) {
        clearTimeout(approvalTimer);
        mentorApprovalTimeouts.delete(messageId);
      }

      const msg = await fetchBookingMessage(booking);
      if (!msg) return;
      const embed = msg.embeds[0];
      const newEmbed = new EmbedBuilder()
        .setColor(embed.color)
        .setTitle(embed.title)
        .setTimestamp()
        .setThumbnail(embed.thumbnail?.url)
        .setFooter(embed.footer?.text ? { text: embed.footer.text } : null);

      for (const field of embed.fields) {
        if (field.name !== 'Mentor') {
          newEmbed.addFields({ name: field.name, value: field.value, inline: field.inline });
        }
      }
      newEmbed.addFields({ name: 'Mentor', value: `<@${booking.mentorId}> \u2705 Approved`, inline: false });
      await msg.edit({ embeds: [newEmbed] });
      await msg.reactions.removeAll().catch(() => {});
      await sendAuditLog({
        action: 'Mentor Approved Booking',
        actorId: user.id,
        targetUserId: entry.ownerId,
        booking,
        reason: 'Mentor reacted with approval',
        color: '#3BA55D'
      });
    } catch (err) {
      console.warn('\u26A0\uFE0F Failed to process mentor approval reaction:', err?.message || err);
    }
  }

  function getBookingEndForCleanup(booking) {
    if (booking?.endUtc) {
      const fromStoredUtc = DateTime.fromISO(booking.endUtc, { zone: 'utc' }).setZone('Pacific/Auckland');
      if (fromStoredUtc.isValid) return fromStoredUtc;
    }

    const nowNz = DateTime.now().setZone('Pacific/Auckland');
    let endNz = buildNzDateTime(booking?.date, booking?.end, nowNz.year);
    if (!endNz) return null;

    if (endNz < nowNz.minus({ days: 180 })) {
      endNz = endNz.plus({ years: 1 });
    }

    return endNz;
  }

  async function cleanupExpiredBookings() {
    const nowNz = DateTime.now().setZone('Pacific/Auckland');

    for (const entry of messages.all()) {
      const ownerId = entry.key;
      const userBookings = entry.data;
      if (!Array.isArray(userBookings)) continue;

      const activeBookings = [];
      const removedBookings = [];
      for (const booking of userBookings) {
        const bookingEnd = getBookingEndForCleanup(booking);
        if (!bookingEnd || bookingEnd > nowNz) {
          activeBookings.push(booking);
          continue;
        }

        clearMentorTimers(booking.messageId);
        clearExtensionSelectionTimer(booking.messageId);
        clearBookingReminderTimer(booking.messageId);

        try {
          const msg = await fetchBookingMessage(booking);
          if (msg) await msg.delete();
        } catch (err) {
          console.warn(`Could not delete expired booking message ${booking.messageId}:`, err?.message || err);
        }

        await sendAuditLog({
          action: 'Expired Booking Auto-Deleted',
          actorLabel: 'System',
          targetUserId: ownerId,
          booking,
          reason: 'Booking end time has passed',
          color: '#D9534F'
        });
        removedBookings.push(booking);
      }

      messages.set(ownerId, activeBookings);
      for (const removedBooking of removedBookings) {
        await refreshEventCoverageNotificationsForBooking(removedBooking);
      }
    }
  }

  function startBookingCleanupScheduler() {
    if (bookingCleanupInterval) return;
    rescheduleAllBookingReminders();
    cleanupExpiredBookings().catch(err => console.warn('Booking cleanup failed:', err?.message || err));
    bookingCleanupInterval = setInterval(() => {
      cleanupExpiredBookings().catch(err => console.warn('Booking cleanup failed:', err?.message || err));
    }, ONE_HOUR_MS);
  }

  return {
    clearMentorTimers,
    clearExtensionSelectionTimer,
    clearBookingReminderTimer,
    findBookingByMessageId,
    scheduleExtensionSelectionTimeout,
    removeBookingAndNotify,
    scheduleMentorTagTimeout,
    scheduleMentorApprovalTimeout,
    remainingFromTimestamp,
    rescheduleMentorTimers,
    scheduleBookingReminder,
    rescheduleBookingReminder,
    rescheduleAllBookingReminders,
    handleMentorApprovalReaction,
    getBookingEndForCleanup,
    cleanupExpiredBookings,
    startBookingCleanupScheduler
  };
}

module.exports = {
  createBookingLifecycle
};
