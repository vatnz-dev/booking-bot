const { randomUUID } = require('node:crypto');
const { ActionRowBuilder, EmbedBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { allExtendableSectors, autoInheritanceMap, sectorCodeMap, FSS_ROLE_ID, MIN_BOOKING_DURATION_MINUTES, roleMap } = require('../constants');
const { DateTime, NZ_ZONE, buildNzDateTime, getBookingDisplayInterval, parseDdMm, parseHhmm, getDurationMinutes, convertToUTC, formatBookingWindowForDiscord, formatBookingDateForDiscord, formatBookingStartForDiscord, formatBookingEndForDiscord } = require('../utils/time');
const { findOverlappingBooking } = require('../utils/bookingConflicts');
const { validateVatnzPosition, evaluateBookingEligibility } = require('../services/positions');
const { getVatsimId } = require('../services/vatsim');
const { applySoloEndorsementOverride, buildOverrideAuditEntry, getBookingStartNz, buildSoloNotice, formatEndorsementScope } = require('../services/soloEndorsements');
const { formatSectorTraffic, formatAerodromeTraffic } = require('../services/traffic');
const { log } = require('../utils/log');

// Compare editable and lifecycle state too: an old form must never overwrite a
// mentor approval, extension selection, reminder or event-thread relocation.
const revision = booking => JSON.stringify(booking);

function createEditBookingHandlers({ client, messages, event, isBookingModerator, getBookingChannel, fetchBookingMessage, sendAuditLog, eventThreadService, bookingLifecycle, runBookingMutation }) {
  const sessions = new Map();
  const { findMatchingEventThreadForBooking, refreshEventCoverageNotificationsForBooking } = eventThreadService;

  function remember(actorId, ownerId, booking) {
    for (const [key, session] of sessions) {
      if (session.expires < Date.now()) sessions.delete(key);
    }
    const token = randomUUID();
    sessions.set(token, { actorId, ownerId, messageId: booking.messageId, revision: revision(booking), expires: Date.now() + 15 * 60 * 1000 });
    return token;
  }

  function resolve(token, interaction) {
    const session = sessions.get(token);
    if (!session || session.expires < Date.now() || session.actorId !== interaction.user.id) return null;
    if (session.ownerId !== interaction.user.id && !isBookingModerator(interaction.member)) return null;
    const bookings = messages.get(session.ownerId);
    const booking = Array.isArray(bookings) && bookings.find(b => b.messageId === session.messageId);
    if (!booking || revision(booking) !== session.revision) return null;
    return { session, booking };
  }

  async function handleEditBookings(interaction) {
    const ownerId = interaction.options.getUser('controller')?.id || interaction.user.id;
    if (ownerId !== interaction.user.id && !isBookingModerator(interaction.member)) {
      await interaction.reply({ content: 'You can only edit your own bookings.', ephemeral: true });
      return sendAuditLog({ action: 'Action Refused', actorId: interaction.user.id, targetUserId: ownerId, reason: 'Tried to edit another controller\'s booking', color: '#D9534F' });
    }
    const bookings = messages.get(ownerId);
    if (!Array.isArray(bookings) || !bookings.length) {
      return interaction.reply({ content: ownerId === interaction.user.id ? 'You have no current bookings.' : `<@${ownerId}> has no current bookings.`, ephemeral: true });
    }
    const options = bookings.slice(0, 25).map(booking => ({
      label: `${booking.position} on ${booking.date} at ${String(booking.start).padStart(4, '0')}`.slice(0, 100),
      description: `Ends at ${String(booking.end).padStart(4, '0')}`,
      value: remember(interaction.user.id, ownerId, booking)
    }));
    return interaction.reply({
      content: `Select a booking to edit${ownerId === interaction.user.id ? '' : ` for <@${ownerId}>`}:`, ephemeral: true,
      components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('edit_booking_select').setPlaceholder('Select a booking to edit').addOptions(options))]
    });
  }

  async function handleEditBookingSelect(interaction) {
    const token = interaction.values[0];
    const entry = resolve(token, interaction);
    if (!entry) return interaction.reply({ content: 'This booking changed or the selection expired. Run /editbookings again.', ephemeral: true });
    const b = entry.booking;
    const fields = [
      ['pos', 'Position (e.g. NZAA_CTR)', b.position, true],
      ['date', 'NZ date (DD/MM)', b.date, true],
      ['start', 'NZ start time (HHMM)', String(b.start).padStart(4, '0'), true],
      ['end', 'NZ end time (HHMM)', String(b.end).padStart(4, '0'), true],
      ['sectors', 'Extra sectors: OCR, BAY, OHA, KAI, NAK, STH', (b.extendedSectors || []).filter(s => !(autoInheritanceMap[b.position] || []).includes(s)).map(s => sectorCodeMap[s] || s).join(', '), false]
    ];
    const modal = new ModalBuilder().setCustomId(`edit_booking:${token}`).setTitle('Edit Controlling Session');
    for (const [id, label, value, required] of fields) {
      const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(id === 'sectors' ? 200 : id === 'pos' ? 12 : id === 'date' ? 5 : 4);
      if (value) input.setValue(value);
      if (id === 'sectors') input.setPlaceholder('Comma separated; blank removes extras. Inheritance is automatic.');
      modal.addComponents(new ActionRowBuilder().addComponents(input));
    }
    return interaction.showModal(modal);
  }

  async function handleEditBookingSubmit(interaction) {
    await interaction.deferReply({ ephemeral: true });
    return runBookingMutation(async () => {
      const token = interaction.customId.slice('edit_booking:'.length);
      const entry = resolve(token, interaction);
      const fail = content => interaction.editReply({ content });
      if (!entry) return fail('This booking changed or the form expired. Run /editbookings again.');
      const { session, booking: before } = entry;
      const position = interaction.fields.getTextInputValue('pos').trim().toUpperCase();
      const date = interaction.fields.getTextInputValue('date').trim();
      const start = interaction.fields.getTextInputValue('start').trim();
      const end = interaction.fields.getTextInputValue('end').trim();
      if (!parseDdMm(date)) return fail('Date must be valid and in DD/MM format.');
      if (!/^\d{4}$/.test(start) || !/^\d{4}$/.test(end) || !parseHhmm(start) || !parseHhmm(end)) return fail('Start and end must be valid 24-hour HHMM times.');
      if (getDurationMinutes(start, end) < MIN_BOOKING_DURATION_MINUTES) return fail(`End must be after start, with at least ${MIN_BOOKING_DURATION_MINUTES} minutes booked.`);
      const validation = await validateVatnzPosition(position);
      if (!validation.valid) return fail(validation.reason);
      if (validation.meta.isEvent && event.get(position) !== date) return fail('This event-only position is not open on that date.');
      const member = session.ownerId === interaction.user.id ? interaction.member : await interaction.guild.members.fetch(session.ownerId);
      if (validation.meta.suffix === 'FSS' && !member.roles.cache.has(FSS_ROLE_ID)) return fail('The controller needs the Oceanic Endorsement for this FSS position.');
      const cid = await getVatsimId(session.ownerId);
      if (!cid) return fail('Could not retrieve the controller\'s linked VATSIM ID. Please try again later.');
      const eligibility = await applySoloEndorsementOverride({ baseEligibility: evaluateBookingEligibility(member, position), cid, member, position, bookingDateNz: getBookingStartNz(date, start), audit: sendAuditLog });
      if (!eligibility.allowed) return fail(eligibility.reason);

      const isCtr = position.endsWith('_CTR') && position !== 'NZAA-R_CTR';
      const codes = Object.fromEntries(Object.entries(sectorCodeMap).map(([key, code]) => [code, key]));
      const requested = interaction.fields.getTextInputValue('sectors').trim().toUpperCase().split(',').map(s => s.trim()).filter(Boolean).map(s => codes[s] || s);
      if (requested.length && !isCtr) return fail('Extra sectors can only be selected for an extendable CTR booking. Clear the extra sectors field for this position.');
      if (requested.some(s => !allExtendableSectors.includes(s) || s === position)) return fail('Use extra sector codes OCR, BAY, OHA, KAI, NAK or STH (or their full callsigns), excluding the booked position.');
      const extendedSectors = isCtr ? [...new Set([...(autoInheritanceMap[position] || []), ...requested])] : [];
      // Keep the stored year when editing the same NZ date, including sessions
      // already in progress. Resolve a changed date using the booking convention
      // of its next occurrence, then anchor both ends to that same year.
      const year = (date === before.date && getBookingDisplayInterval(before)?.startNz.year)
        || DateTime.fromISO(convertToUTC(date, start)).setZone(NZ_ZONE).year;
      const startNz = buildNzDateTime(date, start, year);
      const endNz = buildNzDateTime(date, end, year);
      if (!startNz || !endNz || endNz <= startNz) return fail('The selected date and time window is invalid.');
      const candidate = { ...before, position, date, start: Number(start), end: Number(end), startUtc: startNz.toUTC().toISO(), endUtc: endNz.toUTC().toISO(), extendedSectors };

      // Read again after asynchronous validation; deletion, relocation and mentor
      // actions may have run while directory/endorsement requests were pending.
      if (!resolve(token, interaction)) return fail('This booking changed while being checked. Run /editbookings again.');
      const sectors = new Set([position, ...extendedSectors]);
      for (const { key, data } of messages.all()) {
        for (const other of Array.isArray(data) ? data : data ? [data] : []) {
          if (String(key) === session.ownerId && other.messageId === before.messageId) continue;
          if (!findOverlappingBooking([other], candidate)) continue;
          if (String(key) === session.ownerId) return fail(`You already have an overlapping booking for ${other.position} ${formatBookingWindowForDiscord(other)}.`);
          const occupied = [other.position, ...(other.extendedSectors || [])].find(s => sectors.has(s));
          if (occupied) return fail(`${occupied} is already booked or extended into by <@${key}> ${formatBookingWindowForDiscord(other)}. Choose a different time, position or extra sectors.`);
        }
      }

      const match = await findMatchingEventThreadForBooking(candidate);
      const channel = match?.thread || await getBookingChannel();
      if (!channel?.send) return fail('Could not find the booking channel. The booking has not changed.');
      const oldMessage = await fetchBookingMessage(before);
      if (!oldMessage) return fail('Could not find the existing booking message. The booking has not changed.');
      if (!resolve(token, interaction)) return fail('This booking changed while being checked. Run /editbookings again.');
      const solo = eligibility.soloEndorsement;
      Object.assign(candidate, {
        mentorRequired: eligibility.mentorRequired === true, mentorId: null, mentorApproved: false,
        mentorTaggedAt: null, mentorApprovedAt: null, awaitingExtensionSelection: false,
        mentorTagRequestedAt: new Date().toISOString(),
        reminderSentAt: null, reminderMinutes: null, updatedAt: new Date().toISOString(),
        threadId: match?.thread?.id || null, eventUid: match?.state?.event?.uid || null,
        eventName: match?.state?.event?.title || null,
        soloEndorsement: solo ? { source: solo.source, scope: formatEndorsementScope(solo), endDate: solo.endDate, endDateISO: solo.endDateISO, url: solo.url } : null
      });
      const embed = new EmbedBuilder().setColor('#000000').setTitle(position).setTimestamp().addFields(
        { name: 'Date', value: formatBookingDateForDiscord(candidate) },
        { name: 'Start', value: formatBookingStartForDiscord(candidate), inline: true },
        { name: 'End', value: formatBookingEndForDiscord(candidate), inline: true },
        { name: 'Controller', value: `<@${session.ownerId}>` }
      ).setThumbnail(member.user.displayAvatarURL());
      for (const [id, label] of Object.entries(roleMap)) {
        if (member.roles.cache.has(id)) { embed.setFooter({ text: label }); break; }
      }
      if (candidate.eventName) embed.addFields({ name: 'Event', value: candidate.eventName });
      if (extendedSectors.length) embed.addFields({ name: 'Extended Sectors', value: extendedSectors.map(s => sectorCodeMap[s] || s).join(', ') });
      if (solo) embed.addFields({ name: 'Solo Endorsement', value: buildSoloNotice(solo) });

      // Publish a fresh message so reactions approving the old session cannot
      // approve changed dates, times or positions. Save only after send succeeds.
      const posted = await channel.send({ embeds: [embed] });
      if (!resolve(token, interaction)) {
        await posted.delete();
        return fail('This booking changed while saving. Run /editbookings again.');
      }
      candidate.messageId = posted.id;
      candidate.channelId = channel.id;
      candidate.guildId = channel.guild?.id || before.guildId;
      candidate.previousMessageIds = [];
      const bookings = messages.get(session.ownerId).map(b => b.messageId === before.messageId ? candidate : b);
      try { messages.set(session.ownerId, bookings); } catch (err) {
        await posted.delete();
        throw err;
      }
      sessions.delete(token);
      bookingLifecycle.clearMentorTimers(before.messageId);
      bookingLifecycle.clearExtensionSelectionTimer(before.messageId);
      bookingLifecycle.clearBookingReminderTimer(before.messageId);
      bookingLifecycle.scheduleBookingReminder(session.ownerId, candidate);
      if (candidate.mentorRequired) bookingLifecycle.scheduleMentorTagTimeout(session.ownerId, candidate.messageId);
      let cleanupWarning = '';
      try { await oldMessage.delete(); } catch (err) {
        log('warn', 'edit_old_message_delete_failed', { error: err });
        cleanupWarning = '\nThe previous Discord post could not be removed; staff should remove it.';
      }
      // A failure in ancillary notifications must not imply the saved edit failed.
      for (const action of [
        () => refreshEventCoverageNotificationsForBooking(before),
        () => refreshEventCoverageNotificationsForBooking(candidate),
        () => sendAuditLog({ action: 'Booking Edited', actorId: interaction.user.id, targetUserId: session.ownerId, booking: candidate, reason: `Previously ${before.position} ${formatBookingWindowForDiscord(before)}; sectors: ${(before.extendedSectors || []).join(', ') || 'none'}`, color: '#00AEFF' }),
        ...(solo ? [() => sendAuditLog(buildOverrideAuditEntry(solo, session.ownerId, candidate))] : [])
      ]) {
        try { await action(); } catch (err) { log('warn', 'edit_notification_failed', { error: err }); }
      }
      if (session.ownerId !== interaction.user.id) {
        try {
          const owner = await client.users.fetch(session.ownerId);
          await owner.send({ content: `Staff updated your booking to **${position}** ${formatBookingWindowForDiscord(candidate)}.${candidate.mentorRequired ? '\nMentor approval has been reset. Use /mentor to tag your mentor again within 5 minutes.' : ''}` });
        } catch (err) { log('warn', 'dm_failed', { reason: 'staff_edit', error: err }); }
      }
      await interaction.editReply({ content: `Booking updated: **${position}** ${formatBookingWindowForDiscord(candidate)}.${candidate.mentorRequired ? '\nMentor approval has been reset. Use /mentor to tag your mentor again within 5 minutes.' : ''}${cleanupWarning}` });
      try {
        const previousWeek = startNz.minus({ days: 7 }).toFormat('yyyy-MM-dd');
        const traffic = isCtr ? await formatSectorTraffic([position, ...extendedSectors], previousWeek, start, end) : await formatAerodromeTraffic(position, previousWeek, start, end);
        await interaction.followUp({ content: traffic, ephemeral: true });
      } catch (err) {
        log('warn', 'edit_traffic_lookup_failed', { error: err });
        await interaction.followUp({ content: 'No StatSim data available at the moment due to server/bot errors.', ephemeral: true });
      }
    });
  }
  return { handleEditBookings, handleEditBookingSelect, handleEditBookingSubmit };
}

module.exports = { createEditBookingHandlers };
