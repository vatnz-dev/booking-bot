const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const {
  FSS_ROLE_ID,
  MIN_BOOKING_DURATION_MINUTES,
  THUMBS_UP,
  allExtendableSectors,
  autoInheritanceMap,
  roleMap,
  sectorAerodromeMap,
  sectorCodeMap
} = require('../constants');
const {
  convertToUTC,
  DateTime,
  formatBookingDateForDiscord,
  formatBookingEndForDiscord,
  formatBookingStartForDiscord,
  formatBookingWindowForDiscord,
  getBookingDisplayInterval,
  getDurationMinutes,
  getPreviousWeekNZ,
  NZ_ZONE,
  parseDdMm,
  parseHhmm,
  toDiscordTimestamp
} = require('../utils/time');
const { cleanEmbedValue } = require('../utils/format');
const {
  resolveAerodromes,
  formatAerodromeTraffic,
  formatSectorTraffic,
  getStatsimState,
  setStatsimEnabled,
  STATSIM_DISABLED_MESSAGE
} = require('../services/traffic');
const { validateVatnzPosition, validateVatnzEventPosition, evaluateBookingEligibility } = require('../services/positions');
const { getVatsimId } = require('../services/vatsim');
const {
  applySoloEndorsementOverride,
  buildExpiryWarning,
  buildSoloNotice,
  daysUntilEnd,
  endorsementCoversDate,
  fetchSoloEndorsements,
  formatEndorsementScope,
  getBookingStartNz
} = require('../services/soloEndorsements');

function getBookingDateDisplay(booking) {
  return formatBookingDateForDiscord(booking) || booking.date;
}

function getBookingStartDisplay(booking) {
  return formatBookingStartForDiscord(booking) || String(booking.start);
}

function getBookingEndDisplay(booking) {
  return formatBookingEndForDiscord(booking) || String(booking.end);
}

function getBookingWindowDisplay(booking) {
  return formatBookingWindowForDiscord(booking) || `on ${booking.date} from ${booking.start} to ${booking.end}`;
}

function getBookingSortMillis(booking) {
  return getBookingDisplayInterval(booking)?.startUtc?.toMillis() || 0;
}

function formatBookingConflict(position, ownerId, booking) {
  const controller = ownerId ? `<@${ownerId}>` : 'another controller';
  return `\u274C ${position} is already booked by ${controller} ${getBookingWindowDisplay(booking)}.`;
}

function getEndorsementSourceLabel(endorsement) {
  if (endorsement.source === 's1_622') return 'S1 6.2.2 Solo';
  return 'Solo Endorsement';
}

function getEndorsementDate(value) {
  const date = DateTime.fromISO(String(value || ''), { zone: NZ_ZONE });
  return date.isValid ? date.startOf('day') : null;
}

function formatEndorsementStatus(endorsement) {
  const nowNz = DateTime.now().setZone(NZ_ZONE);
  const start = getEndorsementDate(endorsement.startDateISO);
  const end = getEndorsementDate(endorsement.endDateISO);

  if (endorsementCoversDate(endorsement, nowNz)) {
    const days = daysUntilEnd(endorsement, nowNz);
    const suffix = end ? `expires ${toDiscordTimestamp(end, 'D')} (${toDiscordTimestamp(end, 'R')})` : `expires ${endorsement.endDate}`;
    const daysText = days === 0 ? 'expires today' : `${days} day${days === 1 ? '' : 's'} left`;
    return `Current - ${suffix}${days !== null ? `, ${daysText}` : ''}`;
  }

  if (start?.isValid && nowNz.startOf('day') < start) {
    return `Not active yet - starts ${toDiscordTimestamp(start, 'D')}`;
  }

  return end?.isValid
    ? `Expired ${toDiscordTimestamp(end, 'D')} (${toDiscordTimestamp(end, 'R')})`
    : `Expired or invalid date (${endorsement.endDate || 'unknown expiry'})`;
}

function createInteractionHandlers({
  client,
  event,
  eventclose,
  messages,
  isStaffMember,
  getBookingChannel,
  fetchBookingMessage,
  sendAuditLog,
  eventThreadService,
  bookingLifecycle
}) {
  const buttonCooldowns = new Map();
  const {
    clearMentorTimers,
    clearExtensionSelectionTimer,
    clearBookingReminderTimer,
    scheduleExtensionSelectionTimeout,
    scheduleMentorTagTimeout,
    scheduleMentorApprovalTimeout,
    scheduleBookingReminder
  } = bookingLifecycle;
  const {
    findMatchingEventThreadForBooking,
    handleEventThreadButton,
    refreshEventCoverageNotificationsForBooking
  } = eventThreadService;

  async function handleMyEndorsements(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const cid = await getVatsimId(interaction.user.id);
    if (!cid) {
      await interaction.editReply({
        content: '\u274C Could not retrieve your VATSIM ID. Please ensure your Discord is linked here: https://community.vatsim.net/'
      });
      return;
    }

    let endorsements;
    try {
      endorsements = await fetchSoloEndorsements();
    } catch (err) {
      console.warn('Could not fetch VATNZ solo endorsements for /myendorsements:', err?.message || err);
      await interaction.editReply({ content: 'Could not fetch VATNZ solo endorsements right now. Please try again later.' });
      return;
    }

    const nowNz = DateTime.now().setZone(NZ_ZONE);
    const matching = endorsements
      .filter(endorsement => endorsement.cid === String(cid))
      .sort((a, b) => {
        const aCurrent = endorsementCoversDate(a, nowNz);
        const bCurrent = endorsementCoversDate(b, nowNz);
        if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
        return String(a.endDateISO || '').localeCompare(String(b.endDateISO || ''));
      });

    const embed = new EmbedBuilder()
      .setColor('#0057B8')
      .setTitle('My Solo Endorsements')
      .setDescription(`VATSIM CID: ${cid}`)
      .setTimestamp();

    if (matching.length === 0) {
      embed.addFields({
        name: 'No endorsements found',
        value: 'No VATNZ solo or S1 6.2.2 endorsements were found for your linked VATSIM CID.',
        inline: false
      });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    for (const endorsement of matching.slice(0, 25)) {
      const value = [
        `Scope: ${formatEndorsementScope(endorsement)}`,
        `Status: ${formatEndorsementStatus(endorsement)}`,
        endorsement.approvedBy ? `Approved by: ${endorsement.approvedBy}` : null,
        endorsement.url ? `[Source](${endorsement.url})` : null
      ].filter(Boolean).join('\n');

      const name = `${getEndorsementSourceLabel(endorsement)} - ${endorsement.category || 'VATNZ'}`.slice(0, 256);
      embed.addFields({
        name,
        value: cleanEmbedValue(value),
        inline: false
      });
    }

    if (matching.length > 25) {
      embed.setFooter({ text: `Showing 25 of ${matching.length} endorsements.` });
    }

    await interaction.editReply({ embeds: [embed] });
  }

  async function handleDeleteBookings(interaction) {
    const userId = String(interaction.member.user.id);
    const requestedController = interaction.options.getUser('controller');
    const staff = isStaffMember(interaction.member);

    if (requestedController && requestedController.id !== userId && !staff) {
      await interaction.reply({
        content: 'You can only delete your own bookings.',
        ephemeral: true
      });
      return;
    }

    const targetUserId = requestedController ? requestedController.id : userId;
    const userBookings = messages.get(targetUserId);

    if (!Array.isArray(userBookings) || userBookings.length === 0) {
      await interaction.reply({
        content: targetUserId === userId ? '\u{1F4ED} You have no current bookings.' : `\u{1F4ED} <@${targetUserId}> has no current bookings.`,
        ephemeral: true
      });
      return;
    }

    const options = userBookings.slice(0, 25).map((b, index) => ({
      label: `${b.position} on ${b.date} at ${b.start}`,
      description: `Ends at ${b.end}`,
      value: `${targetUserId}|${index}`
    }));

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('delete_booking_select')
        .setPlaceholder('Select a booking to delete')
        .addOptions(options)
    );

    await interaction.reply({
      content: targetUserId === userId ? '\u{1F5D1}\uFE0F Select a booking to delete:' : `\u{1F5D1}\uFE0F Select a booking to delete for <@${targetUserId}>:`,
      components: [row],
      ephemeral: true
    });
  }

  async function handleExpectedTraffic(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const position = interaction.options.getString('position').trim().toUpperCase();
    const date = interaction.options.getString('date').trim();
    const start = parseHhmm(interaction.options.getString('start'));
    const end = parseHhmm(interaction.options.getString('end'));

    if (!parseDdMm(date)) {
      await interaction.editReply({ content: 'Date must be in DD/MM format.' });
      return;
    }
    if (!start || !end) {
      await interaction.editReply({ content: 'Start and end must be valid 24-hour HHMM times.' });
      return;
    }
    if (Number(start.raw) >= Number(end.raw)) {
      await interaction.editReply({ content: 'Start time must be before end time.' });
      return;
    }

    const isCtr = position.endsWith('_CTR');
    const supportedAerodromes = resolveAerodromes(position);
    if (!isCtr && supportedAerodromes.length === 0) {
      await interaction.editReply({ content: `No aerodrome mapping found for ${position}.` });
      return;
    }
    if (isCtr && !sectorAerodromeMap[position]) {
      await interaction.editReply({ content: `No sector mapping found for ${position}.` });
      return;
    }

    const previousWeekDate = getPreviousWeekNZ(date, start.raw);
    try {
      const traffic = isCtr
        ? await formatSectorTraffic([position], previousWeekDate, start.raw, end.raw)
        : await formatAerodromeTraffic(position, previousWeekDate, start.raw, end.raw);
      await interaction.editReply({ content: traffic });
    } catch (err) {
      console.error('Expected traffic lookup failed:', err);
      await interaction.editReply({ content: 'Could not fetch expected traffic right now. Please try again later.' });
    }
  }

  async function handleStatsim(interaction) {
    await interaction.deferReply({ ephemeral: true });

    if (!isStaffMember(interaction.member)) {
      await interaction.editReply({ content: 'Only staff can change StatSim lookup status.' });
      return;
    }

    const mode = interaction.options.getString('mode');
    const reason = interaction.options.getString('reason')?.trim() || null;

    if (mode === 'status') {
      const state = getStatsimState();
      const status = state.enabled ? 'enabled' : 'disabled';
      const details = [
        `StatSim traffic lookups are currently **${status}**.`,
        `Source: ${state.source}.`
      ];

      if (!state.enabled) {
        details.push(`Users will see: ${STATSIM_DISABLED_MESSAGE}`);
      }
      if (state.reason) {
        details.push(`Reason: ${state.reason}`);
      }
      if (state.updatedBy) {
        details.push(`Last changed by: <@${state.updatedBy}>.`);
      }

      await interaction.editReply({ content: details.join('\n') });
      return;
    }

    if (!['enable', 'disable'].includes(mode)) {
      await interaction.editReply({ content: 'Mode must be status, enable, or disable.' });
      return;
    }

    const enabled = mode === 'enable';
    const state = setStatsimEnabled(enabled, { actorId: interaction.user.id, reason });

    await sendAuditLog({
      action: state.enabled ? 'StatSim Enabled' : 'StatSim Disabled',
      actorId: interaction.user.id,
      reason: reason || (state.enabled ? 'StatSim lookups enabled' : 'StatSim lookups disabled'),
      fields: state.enabled
        ? []
        : [{ name: 'User-facing message', value: STATSIM_DISABLED_MESSAGE, inline: false }],
      color: state.enabled ? '#3BA55D' : '#D9534F'
    });

    await interaction.editReply({
      content: state.enabled
        ? 'StatSim traffic lookups are now **enabled**.'
        : `StatSim traffic lookups are now **disabled**.\nUsers will see: ${STATSIM_DISABLED_MESSAGE}`
    });
  }

  async function handleDeleteBookingSelect(interaction) {
    await interaction.deferUpdate();

    const userId = String(interaction.member.user.id);
    const [targetUserFromValue, selectedIndexFromValue] = String(interaction.values[0]).includes('|')
      ? interaction.values[0].split('|')
      : [userId, interaction.values[0]];
    const selectedIndex = parseInt(selectedIndexFromValue, 10);
    const targetUserId = String(targetUserFromValue);
    const staff = isStaffMember(interaction.member);

    if (targetUserId !== userId && !staff) {
      await interaction.editReply({
        content: 'You can only delete your own bookings.',
        components: []
      });
      return;
    }

    const userBookings = messages.get(targetUserId);

    if (!Array.isArray(userBookings) || !userBookings[selectedIndex]) {
      await interaction.editReply({
        content: '\u274C Booking not found.',
        components: []
      });
      return;
    }

    const booking = userBookings[selectedIndex];

    userBookings.splice(selectedIndex, 1);
    messages.set(targetUserId, userBookings);
    clearMentorTimers(booking.messageId);
    clearExtensionSelectionTimer(booking.messageId);
    clearBookingReminderTimer(booking.messageId);
    await refreshEventCoverageNotificationsForBooking(booking);

    try {
      const messageToDelete = await fetchBookingMessage(booking);
      if (messageToDelete) await messageToDelete.delete();
    } catch (err) {
      console.error(`\u26A0\uFE0F Could not delete message ${booking.messageId}:`, err);
    }

    await sendAuditLog({
      action: targetUserId === userId ? 'Booking Deleted' : 'Staff Deleted Booking',
      actorId: userId,
      targetUserId,
      booking,
      reason: targetUserId === userId ? 'Controller deleted their own booking' : 'Staff deleted another controller booking',
      color: targetUserId === userId ? '#D9534F' : '#FF9900'
    });

    await interaction.editReply({
      content: targetUserId === userId
        ? `\u2705 Booking for ${booking.position} ${getBookingWindowDisplay(booking)} has been deleted.`
        : `\u2705 Booking for ${booking.position} ${getBookingWindowDisplay(booking)} has been deleted for <@${targetUserId}>.`,
      components: []
    });
  }

  async function handlePlan(i) {
    if (i.isModalSubmit()) {
      await i.deferReply({ ephemeral: true });

      const member = i.member;
      const userId = member.user.id;

      const posRaw = i.fields.getTextInputValue('pos');
      const pos = posRaw.trim().toUpperCase();
      const date = i.fields.getTextInputValue('date').trim();
      const start = parseInt(i.fields.getTextInputValue('start').trim());
      const end = parseInt(i.fields.getTextInputValue('end').trim());

      if (posRaw !== pos) return i.editReply({ content: '\u274C Position must be in ALL CAPS.', ephemeral: true });
      if (isNaN(start) || isNaN(end)) return i.editReply({ content: '\u274C Start and End times must be valid numbers.', ephemeral: true });

      const dateRaw = i.fields.getTextInputValue('date').trim();
      const startRaw = i.fields.getTextInputValue('start').trim();
      const endRaw = i.fields.getTextInputValue('end').trim();

      function isValidTime(timeStr) {
        if (!/^\d{4}$/.test(timeStr)) return false;
        const hours = parseInt(timeStr.slice(0, 2), 10);
        const minutes = parseInt(timeStr.slice(2), 10);
        return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
      }

      if (!isValidTime(startRaw) || !isValidTime(endRaw)) {
        await i.editReply({
          content: '\u274C Start and End times must be valid 24-hour times (HHMM).',
          ephemeral: true
        });
        return;
      }

      const starts = parseInt(startRaw, 10);
      const ends = parseInt(endRaw, 10);

      if (starts >= ends) {
        await i.editReply({
          content: '\u274C Start time must be before End time.',
          ephemeral: true
        });
        return;
      }

      const durationMinutes = getDurationMinutes(startRaw, endRaw);
      if (durationMinutes === null || durationMinutes < MIN_BOOKING_DURATION_MINUTES) {
        await i.editReply({
          content: `\u274C Booking sessions must be at least ${MIN_BOOKING_DURATION_MINUTES} minutes long.`,
          ephemeral: true
        });
        return;
      }

      function isValidDate(dateStr) {
        if (!/^\d{2}\/\d{2}$/.test(dateStr)) return false;
        const [day, month] = dateStr.split('/').map(Number);
        if (month < 1 || month > 12) return false;
        const daysInMonth = new Date(new Date().getFullYear(), month, 0).getDate();
        return day >= 1 && day <= daysInMonth;
      }

      if (!isValidDate(dateRaw)) {
        await i.editReply({
          content: '\u274C Date must be valid and in format DD/MM (e.g., 05/12).',
          ephemeral: true
        });
        return;
      }

      const positionValidation = await validateVatnzPosition(pos);
      if (!positionValidation.valid) {
        return i.editReply({ content: `\u274C ${positionValidation.reason}`, ephemeral: true });
      }
      const positionMeta = positionValidation.meta;

      if (positionMeta.isEvent) {
        const unlockedDate = event.get(pos);
        if (!unlockedDate || unlockedDate === '0/0') {
          return i.editReply({ content: '\u274C This event-only position is not open for bookings right now.', ephemeral: true });
        }
        if (unlockedDate !== date) {
          return i.editReply({ content: `\u274C This event-only position is only open for ${unlockedDate}.`, ephemeral: true });
        }
      }

      if (positionMeta.suffix === 'FSS' && !member.roles.cache.has(FSS_ROLE_ID)) {
        return i.editReply({ content: '\u274C You do not have the Oceanic Endorsement required to book this FSS position.', ephemeral: true });
      }

      const vatsimId = await getVatsimId(userId);
      if (!vatsimId) {
        return i.editReply({ content: '\u274C Could not retrieve your VATSIM ID. Please ensure your Discord is linked Here: https://community.vatsim.net/', ephemeral: true });
      }

      const bookingDateNz = getBookingStartNz(date, startRaw);
      const baseEligibility = evaluateBookingEligibility(member, pos);
      const eligibility = await applySoloEndorsementOverride({
        baseEligibility,
        cid: vatsimId,
        member,
        position: pos,
        bookingDateNz
      });
      if (!eligibility.allowed) {
        return i.editReply({ content: eligibility.reason, ephemeral: true });
      }
      const mentorRequired = eligibility.mentorRequired === true;
      const soloEndorsement = eligibility.soloEndorsement || null;

      const rawDB = messages.all();
      const isCTR = pos.endsWith("_CTR") && pos !== "NZAA-R_CTR";
      const extendedSectors = isCTR ? [...(autoInheritanceMap[pos] || [])] : [];
      const newBookingSectors = [pos, ...extendedSectors];

      for (const entry of rawDB) {
        const conflictOwnerId = String(entry.key);
        const bookings = entry.data;
        if (!Array.isArray(bookings)) continue;

        for (const b of bookings) {
          if (b.date !== date || b.position !== pos) continue;
          const bStart = parseInt(b.start);
          const bEnd = parseInt(b.end);
          const timeOverlap = !(end <= bStart || start >= bEnd);
          if (timeOverlap) {
            return i.editReply({ content: formatBookingConflict(pos, conflictOwnerId, b), ephemeral: true });
          }
        }
      }

      for (const entry of rawDB) {
        const bookings = entry.data;
        const otherUserId = entry.key;
        if (!Array.isArray(bookings)) continue;

        for (const b of bookings) {
          if (!Array.isArray(b.extendedSectors)) continue;
          if (b.date !== date) continue;

          const bStart = parseInt(b.start);
          const bEnd = parseInt(b.end);
          const timeOverlap = !(end <= bStart || start >= bEnd);
          if (!timeOverlap) continue;

          const original = [...b.extendedSectors];
          const removedSectors = original.filter(s => newBookingSectors.includes(s));
          b.extendedSectors = b.extendedSectors.filter(s => !newBookingSectors.includes(s));

          if (removedSectors.length > 0) {
            try {
              const msg = await fetchBookingMessage(b);
              if (!msg) throw new Error('Booking message not found');
              const embed = msg.embeds[0];
              const newEmbed = new EmbedBuilder()
                .setColor(embed.color)
                .setTitle(embed.title)
                .setTimestamp()
                .setThumbnail(embed.thumbnail?.url)
                .setFooter(embed.footer?.text ? { text: embed.footer.text } : null);

              for (const field of embed.fields) {
                if (field.name !== 'Extended Sectors') {
                  newEmbed.addFields({ name: field.name, value: field.value, inline: field.inline });
                }
              }

              if (b.extendedSectors.length > 0) {
                const display = b.extendedSectors.map(s => sectorCodeMap[s] || s);
                newEmbed.addFields({ name: 'Extended Sectors', value: display.join(', '), inline: false });
              }

              await msg.edit({ embeds: [newEmbed] });
            } catch (err) {
              console.warn(`\u26A0\uFE0F Could not update embed for booking ${b.messageId}`);
            }

            try {
              const user = await client.users.fetch(otherUserId);
              const reason = otherUserId === userId
                ? 'You booked a new session that overrides these sectors.'
                : 'Another controller booked or inherited these sectors.';

              await user.send({
                content: `\u{1F4ED} One or more extended sectors were removed from your booking.`,
                embeds: [
                  new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('Extended Sectors Removed')
                    .setDescription(
                      `The following sectors were removed from your booking ${getBookingWindowDisplay(b)}:\n` +
                      removedSectors.map(s => `\u2022 ${sectorCodeMap[s] || s}`).join('\n') +
                      `\n\nReason: ${reason}`
                    )
                    .setFooter({ text: 'VATNZ Booking System' })
                ]
              });
            } catch (err) {
              console.warn(`\u26A0\uFE0F Could not DM user ${otherUserId}: ${err}`);
            }

            messages.set(otherUserId, bookings);
            await refreshEventCoverageNotificationsForBooking(b);
          }
        }
      }

      const startUTC = convertToUTC(date, String(start).padStart(4, '0'));
      const endUTC = convertToUTC(date, String(end).padStart(4, '0'));
      const bookingDisplayRecord = { date, start, end, startUtc: startUTC, endUtc: endUTC };

      const bookingEmbed = new EmbedBuilder()
        .setColor('#000000')
        .setTitle(pos)
        .setTimestamp(new Date())
        .addFields(
          { name: 'Date', value: getBookingDateDisplay(bookingDisplayRecord), inline: false },
          { name: 'Start', value: getBookingStartDisplay(bookingDisplayRecord), inline: true },
          { name: 'End', value: getBookingEndDisplay(bookingDisplayRecord), inline: true },
          { name: 'Controller', value: `<@${userId}>`, inline: false }
        )
        .setThumbnail(member.user.displayAvatarURL({ format: "png" }));

      const matchingEventThread = await findMatchingEventThreadForBooking({ position: pos, date, start, end });
      const matchedEventName = matchingEventThread?.state?.event?.title || null;

      if (matchedEventName) {
        bookingEmbed.addFields({ name: 'Event', value: matchedEventName, inline: false });
      }
      if (extendedSectors.length > 0) {
        const display = extendedSectors.map(s => sectorCodeMap[s] || s);
        bookingEmbed.addFields({ name: 'Extended Sectors', value: display.join(', '), inline: false });
      }
      if (soloEndorsement) {
        bookingEmbed.addFields({
          name: 'Solo Endorsement',
          value: buildSoloNotice(soloEndorsement),
          inline: false
        });
      }

      for (const [roleId, label] of Object.entries(roleMap)) {
        if (member.roles.cache.has(roleId)) {
          bookingEmbed.setFooter({ text: label });
          break;
        }
      }

      const channel = matchingEventThread?.thread || await getBookingChannel();
      if (!channel?.send) {
        return i.editReply({ content: '\u274C Could not find the booking channel. Check CHANNEL_ID.', ephemeral: true });
      }
      const sentMessage = await channel.send({ embeds: [bookingEmbed] });

      const existing = messages.get(userId);
      const userBookings = Array.isArray(existing) ? existing : (existing ? [existing] : []);
      const createdBooking = {
        position: pos,
        date,
        start,
        end,
        messageId: sentMessage.id,
        channelId: channel.id,
        guildId: channel.guild?.id,
        threadId: matchingEventThread?.thread?.id || null,
        eventUid: matchingEventThread?.state?.event?.uid || null,
        eventName: matchedEventName || null,
        extendedSectors,
        awaitingExtensionSelection: false,
        mentorRequired,
        mentorId: null,
        mentorApproved: false,
        soloEndorsement: soloEndorsement ? {
          source: soloEndorsement.source,
          scope: formatEndorsementScope(soloEndorsement),
          endDate: soloEndorsement.endDate,
          endDateISO: soloEndorsement.endDateISO,
          url: soloEndorsement.url
        } : null,
        startUtc: startUTC,
        endUtc: endUTC,
        createdAt: new Date().toISOString()
      };
      userBookings.push(createdBooking);
      messages.set(userId, userBookings);
      scheduleBookingReminder(userId, createdBooking);
      await refreshEventCoverageNotificationsForBooking(createdBooking);

      await sendAuditLog({
        action: 'Booking Created',
        actorId: userId,
        targetUserId: userId,
        booking: createdBooking,
        reason: matchingEventThread ? `Routed to event thread: ${matchedEventName}` : 'Controller created a booking',
        color: '#00AEFF'
      });

      const prevDate = getPreviousWeekNZ(date, String(start).padStart(4, '0'));
      if (mentorRequired) {
        scheduleMentorTagTimeout(userId, sentMessage.id);
      }
      const expiryWarning = soloEndorsement ? buildExpiryWarning(soloEndorsement) : null;
      const mentorNotice = mentorRequired
        ? '\nMentor required. If you do not tag a mentor within 5 minutes, this booking will be auto-deleted.'
        : soloEndorsement
          ? `\n${buildSoloNotice(soloEndorsement)}${expiryWarning ? `\n${expiryWarning}` : ''}`
        : '';

      if (isCTR) {
        const unavailable = new Set();
        for (const entry of rawDB) {
          const bookings = entry.data;
          if (!Array.isArray(bookings)) continue;

          for (const b of bookings) {
            if (b.date !== date) continue;
            const bStart = parseInt(b.start);
            const bEnd = parseInt(b.end);
            const timeOverlap = !(end <= bStart || start >= bEnd);
            if (!timeOverlap) continue;

            unavailable.add(b.position);
            if (Array.isArray(b.extendedSectors)) {
              for (const ext of b.extendedSectors) {
                unavailable.add(ext);
              }
            }
          }
        }

        const availableSectors = allExtendableSectors.filter(sector =>
          sector !== pos &&
          !extendedSectors.includes(sector) &&
          !unavailable.has(sector)
        );

        if (availableSectors.length === 0) {
          await i.editReply({
            content: 'Booking created. No additional sectors available for extension.' + mentorNotice,
            ephemeral: true
          });

          const traffic = await formatSectorTraffic(
            [pos],
            prevDate,
            String(start).padStart(4, '0'),
            String(end).padStart(4, '0')
          );
          await i.followUp({ content: traffic, ephemeral: true });
        } else {
          const createdBooking = userBookings.find(b => b.messageId === sentMessage.id);
          if (createdBooking) {
            createdBooking.awaitingExtensionSelection = true;
            messages.set(userId, userBookings);
            scheduleExtensionSelectionTimeout(userId, sentMessage.id);
          }

          const options = [
            {
              label: 'No extension',
              value: `${sentMessage.id}|NO_EXTENSION`
            },
            ...availableSectors.map(sector => ({
              label: sector,
              value: `${sentMessage.id}|${sector}`
            }))
          ];
          const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('extend_sector_select')
              .setPlaceholder('Select sectors to extend into')
              .setMinValues(1)
              .setMaxValues(options.length)
              .addOptions(options)
          );

          await i.editReply({
            content: 'Booking created. Select sectors you want to extend into (or choose No extension). If you dismiss this, it will auto-default to No extension and DM your traffic in 3 minutes.' + mentorNotice,
            components: [row],
            ephemeral: true
          });
        }
      } else {
        await i.editReply({
          content: 'Booking created. To delete, run /deletebookings with the same position and date.' + mentorNotice,
          ephemeral: true
        });

        const traffic = await formatAerodromeTraffic(
          pos,
          prevDate,
          String(start).padStart(4, '0'),
          String(end).padStart(4, '0')
        );
        await i.followUp({ content: traffic, ephemeral: true });
      }
    } else {
      const userId = i.user.id;
      const now = Date.now();
      const cooldown = 5000;

      if (buttonCooldowns.has(userId) && now - buttonCooldowns.get(userId) < cooldown) {
        return i.reply({
          content: '\u23F3 Please wait before clicking again.',
          ephemeral: true
        });
      }

      buttonCooldowns.set(userId, now);
      if (i.customId === 'plan') {
        const planModal = new ModalBuilder()
          .setCustomId('plan')
          .setTitle('Book Controlling Session')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('pos')
                .setLabel('What Position? Format: NZAA_CTR')
                .setStyle(TextInputStyle.Short)
                .setMinLength(8)
                .setMaxLength(12)
                .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('date')
                .setLabel('What Date? Format: 25/06')
                .setStyle(TextInputStyle.Short)
                .setMinLength(5)
                .setMaxLength(5)
                .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('start')
                .setLabel('What Time Do You Plan To Start? Format: 1800')
                .setStyle(TextInputStyle.Short)
                .setMinLength(4)
                .setMaxLength(4)
                .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('end')
                .setLabel('What Time Do You Plan To End? Format: 1900')
                .setStyle(TextInputStyle.Short)
                .setMinLength(4)
                .setMaxLength(4)
                .setRequired(true)
            )
          );

        await i.showModal(planModal);
      }
    }
  }

  async function handleViewBookings(interaction) {
    const userId = String(interaction.member.user.id);
    const userBookings = messages.get(userId);

    if (!Array.isArray(userBookings) || userBookings.length === 0) {
      await interaction.reply({
        content: '\u{1F4ED} You have no current bookings.',
        ephemeral: true
      });
      return;
    }

    const sorted = [...userBookings].sort((a, b) => getBookingSortMillis(a) - getBookingSortMillis(b));

    const embed = new EmbedBuilder()
      .setTitle('\u{1F4CB} Your Bookings')
      .setColor('#00AEFF')
      .setDescription(
        sorted.map(b =>
          `\u2022 **${b.position}**: ${getBookingWindowDisplay(b)}`
        ).join('\n')
      )
      .setFooter({ text: 'Use /deletebookings to remove a booking.' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  async function handleOpenEventPosition(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const position = interaction.options.getString('position').trim().toUpperCase();
    const date = interaction.options.getString('date');

    if (!/^\d{2}\/\d{2}$/.test(date)) {
      await interaction.editReply({ content: 'Date must be in the format DD/MM (e.g., 25/06). Please correct it.' });
      return;
    }

    const positionValidation = await validateVatnzEventPosition(position);
    if (!positionValidation.valid) {
      await interaction.editReply({ content: positionValidation.reason });
      return;
    }

    event.set(position, date);

    const embed = {
      color: 0x000000,
      title: 'Event Position Opened',
      fields: [
        { name: 'Date', value: date, inline: false },
        { name: 'Position', value: position, inline: false }
      ]
    };

    const channel = await getBookingChannel();
    if (!channel?.send) {
      await interaction.editReply({ content: 'Booking channel not found.' });
      return;
    }
    const sentMessage = await channel.send({ embeds: [embed] });

    eventclose.set(position, sentMessage.id);
    await sendAuditLog({
      action: 'Event Position Opened',
      actorId: interaction.user.id,
      fields: [
        { name: 'Position', value: position, inline: true },
        { name: 'Date', value: date, inline: true },
        { name: 'Message', value: `[Open message](https://discord.com/channels/${sentMessage.guild?.id || client.guilds.cache.first()?.id}/${channel.id}/${sentMessage.id})`, inline: false }
      ],
      color: '#00AEFF'
    });

    await interaction.editReply({ content: `${position} opened!` });
  }

  async function handleExtendSectorSelect(interaction) {
    try {
      await interaction.deferUpdate();

      const selections = interaction.values;
      const userId = String(interaction.member.user.id);
      const userBookings = messages.get(userId);
      if (!Array.isArray(userBookings)) return;

      const [messageId] = selections[0].split('|');
      const booking = userBookings.find(b => b.messageId === messageId || (Array.isArray(b.previousMessageIds) && b.previousMessageIds.includes(messageId)));
      if (!booking) return;

      if (selections.includes(`${messageId}|NO_EXTENSION`)) {
        clearExtensionSelectionTimer(messageId);
        booking.awaitingExtensionSelection = false;
        messages.set(userId, userBookings);

        await interaction.editReply({ content: '\u2705 No additional sectors selected.', components: [] });

        const prevDate = getPreviousWeekNZ(booking.date, String(booking.start).padStart(4, '0'));
        const traffic = await formatSectorTraffic(
          [booking.position, ...(booking.extendedSectors || [])],
          prevDate,
          String(booking.start).padStart(4, '0'),
          String(booking.end).padStart(4, '0')
        );
        await interaction.followUp({ content: traffic, ephemeral: true });
        return;
      }

      const rawDB = messages.all();
      const unavailable = new Set();

      for (const entry of rawDB) {
        const bookings = entry.data;
        if (!Array.isArray(bookings)) continue;

        for (const b of bookings) {
          if (b.date !== booking.date) continue;
          const bStart = parseInt(b.start);
          const bEnd = parseInt(b.end);
          const timeOverlap = !(booking.end <= bStart || booking.start >= bEnd);
          if (!timeOverlap) continue;

          unavailable.add(b.position);
          if (Array.isArray(b.extendedSectors)) {
            for (const ext of b.extendedSectors) {
              unavailable.add(ext);
            }
          }
        }
      }

      let updated = false;

      for (const selection of selections) {
        const [, sector] = selection.split('|');
        if (!unavailable.has(sector) && !booking.extendedSectors.includes(sector)) {
          booking.extendedSectors.push(sector);
          updated = true;
        }
      }

      if (updated) {
        const msg = await fetchBookingMessage(booking);
        if (!msg) throw new Error('Booking message not found');
        const embed = msg.embeds[0];
        const newEmbed = new EmbedBuilder()
          .setColor(embed.color)
          .setTitle(embed.title)
          .setTimestamp()
          .setThumbnail(embed.thumbnail?.url)
          .setFooter(embed.footer?.text ? { text: embed.footer.text } : null);

        for (const field of embed.fields) {
          if (field.name !== 'Extended Sectors') {
            newEmbed.addFields({ name: field.name, value: field.value, inline: field.inline });
          }
        }

        if (booking.extendedSectors.length > 0) {
          const display = booking.extendedSectors.map(s => sectorCodeMap[s] || s);
          newEmbed.addFields({ name: 'Extended Sectors', value: display.join(', '), inline: false });
        }

        await msg.edit({ embeds: [newEmbed] });
        messages.set(userId, userBookings);
      }

      clearExtensionSelectionTimer(messageId);
      booking.awaitingExtensionSelection = false;
      messages.set(userId, userBookings);
      if (updated) {
        await refreshEventCoverageNotificationsForBooking(booking);
      }

      await interaction.editReply({ content: '\u2705 Extended sectors updated.', components: [] });

      const prevDate = getPreviousWeekNZ(booking.date, String(booking.start).padStart(4, '0'));
      const allSectors = [booking.position, ...booking.extendedSectors];
      const traffic = await formatSectorTraffic(
        allSectors,
        prevDate,
        String(booking.start).padStart(4, '0'),
        String(booking.end).padStart(4, '0')
      );

      await interaction.followUp({
        content: traffic,
        ephemeral: true
      });
    } catch (err) {
      console.error('\u274C Error in extend_sector_select handler:', err);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: '\u274C Something went wrong.', components: [] });
        } else {
          await interaction.reply({ content: '\u274C Something went wrong.', components: [], ephemeral: true });
        }
      } catch (e) {
        console.warn('\u26A0\uFE0F Failed to send error reply:', e);
      }
    }
  }

  async function handleCloseEventPosition(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const position = interaction.options.getString('position').trim().toUpperCase();
    const positionValidation = await validateVatnzEventPosition(position);
    if (!positionValidation.valid) {
      await interaction.editReply({ content: positionValidation.reason });
      return;
    }

    event.set(position, '0/0');
    const bookingChannel = await getBookingChannel();
    const closeMessageId = eventclose.get(position);
    if (bookingChannel?.messages && closeMessageId) {
      try {
        const s4dmessage = await bookingChannel.messages.fetch(closeMessageId);
        await s4dmessage.delete();
      } catch (err) {
        console.warn(`Could not delete event close message ${closeMessageId}:`, err?.message || err);
      }
    }
    await interaction.editReply({ content: `${position} closed!`, components: [] });
    await sendAuditLog({
      action: 'Event Position Closed',
      actorId: interaction.user.id,
      fields: [
        { name: 'Position', value: position, inline: true }
      ],
      color: '#D9534F'
    });
  }

  async function handleMentorBookingSelect(interaction) {
    await interaction.deferUpdate();

    const [selectedIndex, mentorId] = interaction.values[0].split('|');
    const userId = String(interaction.member.user.id);
    const userBookings = messages.get(userId);

    if (!Array.isArray(userBookings) || !userBookings[selectedIndex]) {
      await interaction.editReply({
        content: '\u274C Booking not found.',
        components: []
      });
      return;
    }

    const booking = userBookings[selectedIndex];

    let messageLink = '';
    try {
      const s4dmessage = await fetchBookingMessage(booking);
      if (!s4dmessage) throw new Error('Booking message not found');
      await s4dmessage.react(THUMBS_UP);

      const channelId = booking.channelId || process.env.CHANNEL_ID;
      const guildId = booking.guildId || s4dmessage.guild?.id || client.guilds.cache.first()?.id;
      messageLink = `https://discord.com/channels/${guildId}/${channelId}/${booking.messageId}`;

      const embed = s4dmessage.embeds[0];
      if (embed) {
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

        newEmbed.addFields({
          name: 'Mentor',
          value: booking.mentorRequired ? `<@${mentorId}> (Pending Approval)` : `<@${mentorId}>`,
          inline: false
        });
        await s4dmessage.edit({ embeds: [newEmbed] });
      }
    } catch (err) {
      console.error('\u274C Failed to fetch/update booking message:', err);
    }

    booking.mentorId = mentorId;
    booking.mentorApproved = false;
    booking.mentorTaggedAt = new Date().toISOString();
    messages.set(userId, userBookings);
    await sendAuditLog({
      action: 'Mentor Tagged Booking',
      actorId: userId,
      targetUserId: userId,
      booking,
      reason: `Mentor tagged: <@${mentorId}>`,
      color: '#5865F2'
    });

    clearMentorTimers(booking.messageId);
    if (booking.mentorRequired) {
      scheduleMentorApprovalTimeout(userId, booking.messageId);
    }

    try {
      const guild = interaction.guild || client.guilds.cache.first();
      const mentorMember = guild.members.cache.get(mentorId) || await guild.members.fetch(mentorId);

      await mentorMember.send({
        content: messageLink,
        embeds: [{
          color: 0x000000,
          title: 'Your student has booked a session',
          description: booking.mentorRequired
            ? `${interaction.user.username} has booked **${booking.position}** ${getBookingWindowDisplay(booking)} and tagged you. Please react with ${THUMBS_UP} on the booking message above within 30 minutes.`
            : `${interaction.user.username} has booked **${booking.position}** ${getBookingWindowDisplay(booking)} and tagged you.`
        }]
      });
    } catch (err) {
      console.error('\u274C Failed to DM mentor:', err);
    }

    await interaction.editReply({
      content: booking.mentorRequired
        ? `\u2705 Booking for ${booking.position} ${getBookingWindowDisplay(booking)} has been sent to your mentor. They have 30 minutes to approve with ${THUMBS_UP}.`
        : `\u2705 Booking for ${booking.position} ${getBookingWindowDisplay(booking)} has been sent to your mentor.`,
      components: []
    });
  }

  async function handleMentor(interaction) {
    const userId = String(interaction.member.user.id);
    const mentor = interaction.options.getMember('mentor');
    const userBookings = messages.get(userId);

    if (!Array.isArray(userBookings) || userBookings.length === 0) {
      await interaction.reply({
        content: '\u{1F4ED} You have no bookings to tag a mentor for.',
        ephemeral: true
      });
      return;
    }

    const options = userBookings.map((b, index) => ({
      label: `${b.position} on ${b.date} at ${b.start}`,
      description: `Ends at ${b.end}`,
      value: `${index}|${mentor.id}`
    }));

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('mentor_booking_select')
        .setPlaceholder(`Select a booking to notify ${mentor.user.username}`)
        .addOptions(options)
    );

    await interaction.reply({
      content: `\u{1F468}\u200D\u{1F3EB} Select the booking you want to notify **${mentor.user.username}** about:`,
      components: [row],
      ephemeral: true
    });
  }

  function registerInteractionHandlers() {
    client.on('interactionCreate', async (interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          switch (interaction.commandName) {
            case 'closeeventposition':
              await handleCloseEventPosition(interaction);
              break;
            case 'deletebookings':
              await handleDeleteBookings(interaction);
              break;
            case 'expectedtraffic':
              await handleExpectedTraffic(interaction);
              break;
            case 'myendorsements':
              await handleMyEndorsements(interaction);
              break;
            case 'mentor':
              await handleMentor(interaction);
              break;
            case 'openeventposition':
              await handleOpenEventPosition(interaction);
              break;
            case 'statsim':
              await handleStatsim(interaction);
              break;
            case 'viewbookings':
              await handleViewBookings(interaction);
              break;
          }
          return;
        }

        if (interaction.isButton()) {
          if (interaction.customId.startsWith('event_thread_')) {
            await handleEventThreadButton(interaction);
            return;
          }

          switch (interaction.customId) {
            case 'plan':
              await handlePlan(interaction);
              break;
          }
          return;
        }

        if (interaction.isStringSelectMenu()) {
          switch (interaction.customId) {
            case 'delete_booking_select':
              await handleDeleteBookingSelect(interaction);
              break;
            case 'extend_sector_select':
              await handleExtendSectorSelect(interaction);
              break;
            case 'mentor_booking_select':
              await handleMentorBookingSelect(interaction);
              break;
          }
          return;
        }

        if (interaction.isModalSubmit()) {
          switch (interaction.customId) {
            case 'plan':
              await handlePlan(interaction);
              break;
          }
        }
      } catch (err) {
        console.error('Interaction handler failed:', err);
        try {
          const payload = { content: 'Something went wrong while handling that interaction. Please try again.', components: [], ephemeral: true };
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply(payload);
          } else {
            await interaction.reply(payload);
          }
        } catch (replyErr) {
          console.warn('Could not send interaction error response:', replyErr?.message || replyErr);
        }
      }
    });
  }

  return {
    registerInteractionHandlers,
    handleMyEndorsements,
    handleDeleteBookings,
    handleExpectedTraffic,
    handleDeleteBookingSelect,
    handlePlan,
    handleViewBookings,
    handleOpenEventPosition,
    handleStatsim,
    handleExtendSectorSelect,
    handleCloseEventPosition,
    handleMentorBookingSelect,
    handleMentor
  };
}

module.exports = {
  createInteractionHandlers
};
