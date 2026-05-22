const { EmbedBuilder } = require('discord.js');

const {
  MENTOR_TAG_TIMEOUT_MS,
  MENTOR_APPROVAL_TIMEOUT_MS,
  ONE_HOUR_MS,
  THUMBS_UP
} = require('../constants');
const { DateTime, buildNzDateTime, getPreviousWeekNZ } = require('../utils/time');
const { formatSectorTraffic } = require('./traffic');

function createBookingLifecycle({ client, messages, fetchBookingMessage, sendAuditLog }) {
  const mentorTagTimeouts = new Map();
  const mentorApprovalTimeouts = new Map();
  const extensionSelectionTimeouts = new Map();
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
        console.warn(`âš ï¸ Could not DM user ${ownerId} with fallback extension stats:`, err?.message || err);
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

    try {
      const msg = await fetchBookingMessage(removedBooking);
      if (msg) await msg.delete();
    } catch (err) {
      console.warn(`âš ï¸ Could not auto-delete booking message ${messageId}:`, err?.message || err);
    }

    if (dmText) {
      try {
        const user = await client.users.fetch(entry.ownerId);
        await user.send({ content: dmText });
      } catch (err) {
        console.warn(`âš ï¸ Could not DM user ${ownerId} about auto-deletion:`, err?.message || err);
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
      scheduleMentorTagTimeout(ownerId, booking.messageId, remainingFromTimestamp(booking.createdAt, MENTOR_TAG_TIMEOUT_MS));
      return;
    }

    scheduleMentorApprovalTimeout(ownerId, booking.messageId, remainingFromTimestamp(booking.mentorTaggedAt, MENTOR_APPROVAL_TIMEOUT_MS));
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
      newEmbed.addFields({ name: 'Mentor', value: `<@${booking.mentorId}> âœ… Approved`, inline: false });
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
      console.warn('âš ï¸ Failed to process mentor approval reaction:', err?.message || err);
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
      for (const booking of userBookings) {
        const bookingEnd = getBookingEndForCleanup(booking);
        if (!bookingEnd || bookingEnd > nowNz) {
          activeBookings.push(booking);
          continue;
        }

        clearMentorTimers(booking.messageId);
        clearExtensionSelectionTimer(booking.messageId);

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
      }

      messages.set(ownerId, activeBookings);
    }
  }

  function startBookingCleanupScheduler() {
    if (bookingCleanupInterval) return;
    cleanupExpiredBookings().catch(err => console.warn('Booking cleanup failed:', err?.message || err));
    bookingCleanupInterval = setInterval(() => {
      cleanupExpiredBookings().catch(err => console.warn('Booking cleanup failed:', err?.message || err));
    }, ONE_HOUR_MS);
  }

  return {
    clearMentorTimers,
    clearExtensionSelectionTimer,
    findBookingByMessageId,
    scheduleExtensionSelectionTimeout,
    removeBookingAndNotify,
    scheduleMentorTagTimeout,
    scheduleMentorApprovalTimeout,
    remainingFromTimestamp,
    rescheduleMentorTimers,
    handleMentorApprovalReaction,
    getBookingEndForCleanup,
    cleanupExpiredBookings,
    startBookingCleanupScheduler
  };
}

module.exports = {
  createBookingLifecycle
};
