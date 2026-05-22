const axios = require('axios');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder
} = require('discord.js');

const {
  EVENT_CALENDAR_URL,
  EVENT_LOOKAHEAD_DAYS,
  LOG_CHANNEL_ID,
  ONE_HOUR_MS,
  STAFF_ROLE_ID,
  THUMBS_UP,
  sectorCodeMap
} = require('../constants');
const { cleanEmbedValue, summarizeError } = require('../utils/format');
const { DateTime, bookingOverlapsEvent, getEventDateTimes } = require('../utils/time');

function unfoldIcsLines(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const unfolded = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

function unescapeIcsValue(value) {
  return String(value || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function parseIcsDate(value) {
  const raw = String(value || '').trim();
  if (/^\d{8}T\d{6}Z$/.test(raw)) {
    return DateTime.fromFormat(raw, "yyyyMMdd'T'HHmmss'Z'", { zone: 'utc' });
  }
  if (/^\d{8}T\d{6}$/.test(raw)) {
    return DateTime.fromFormat(raw, "yyyyMMdd'T'HHmmss", { zone: 'utc' });
  }
  if (/^\d{8}$/.test(raw)) {
    return DateTime.fromFormat(raw, 'yyyyMMdd', { zone: 'Pacific/Auckland' }).toUTC();
  }
  return DateTime.fromISO(raw, { zone: 'utc' });
}

function parseVatnzIcsEvents(icsText) {
  const eventsOut = [];
  let current = null;

  for (const line of unfoldIcsLines(icsText)) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current?.uid && current?.title && current?.startUtc?.isValid && current?.endUtc?.isValid) {
        eventsOut.push({
          uid: current.uid,
          title: current.title,
          startUtcISO: current.startUtc.toUTC().toISO(),
          endUtcISO: current.endUtc.toUTC().toISO(),
          url: current.url,
          categories: current.categories || []
        });
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const splitAt = line.indexOf(':');
    if (splitAt === -1) continue;

    const rawKey = line.slice(0, splitAt);
    const prop = rawKey.split(';')[0].toUpperCase();
    const value = unescapeIcsValue(line.slice(splitAt + 1));

    if (prop === 'UID') current.uid = value;
    if (prop === 'SUMMARY') current.title = value;
    if (prop === 'DTSTART') current.startUtc = parseIcsDate(value);
    if (prop === 'DTEND') current.endUtc = parseIcsDate(value);
    if (prop === 'ATTACH' || prop === 'URL') {
      current.url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    }
    if (prop === 'CATEGORIES') current.categories = value.split(',').map(v => v.trim()).filter(Boolean);
  }

  return eventsOut;
}

function compactEventState(eventData) {
  return {
    uid: eventData.uid,
    title: eventData.title,
    startUtcISO: eventData.startUtcISO,
    endUtcISO: eventData.endUtcISO,
    url: eventData.url,
    categories: eventData.categories || []
  };
}

function eventStateKey(uid) {
  return Buffer.from(String(uid || 'unknown')).toString('base64url');
}

function formatEventWindow(eventData) {
  const eventTimes = getEventDateTimes(eventData);
  if (!eventTimes) return 'Unknown time';
  const sameDay = eventTimes.startNz.hasSame(eventTimes.endNz, 'day');
  if (sameDay) {
    return `${eventTimes.startNz.toFormat('dd LLL yyyy HH:mm')} ${eventTimes.startNz.offsetNameShort}-${eventTimes.endNz.toFormat('HH:mm')} ${eventTimes.endNz.offsetNameShort}`;
  }
  return `${eventTimes.startNz.toFormat('dd LLL yyyy HH:mm')} ${eventTimes.startNz.offsetNameShort} to ${eventTimes.endNz.toFormat('dd LLL yyyy HH:mm')} ${eventTimes.endNz.offsetNameShort}`;
}

function isEventWithinThreadWindow(eventData) {
  const eventTimes = getEventDateTimes(eventData);
  if (!eventTimes) return false;
  const nowNz = DateTime.now().setZone('Pacific/Auckland');
  return eventTimes.endNz > nowNz && eventTimes.startNz <= nowNz.plus({ days: EVENT_LOOKAHEAD_DAYS });
}

function isChristchurchControlEvent(eventData) {
  const normalized = String(eventData?.title || '')
    .toLowerCase()
    .replace(/chrsitchurch/g, 'christchurch')
    .replace(/christchruch/g, 'christchurch')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.includes('christchurch control');
}

function normalizeEventTitleForThreadName(title) {
  return String(title || 'VATNZ Event')
    .replace(/chrsitchurch/gi, 'Christchurch')
    .replace(/christchruch/gi, 'Christchurch')
    .replace(/\s+/g, ' ')
    .trim();
}

function ordinalDay(day) {
  const value = Number(day);
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

function buildEventThreadName(eventData) {
  const eventTimes = getEventDateTimes(eventData);
  const eventTitle = normalizeEventTitleForThreadName(eventData.title);
  const suffix = eventTimes ? `${ordinalDay(eventTimes.startNz.day)} ${eventTimes.startNz.toFormat('LLLL')}` : 'event';
  return `${eventTitle} - ${suffix}`.slice(0, 100);
}

function buildEventEmbed(eventData, title = 'VATNZ Event') {
  const embed = new EmbedBuilder()
    .setColor('#0057B8')
    .setTitle(title)
    .addFields(
      { name: 'Event', value: cleanEmbedValue(eventData.title), inline: false },
      { name: 'Time', value: cleanEmbedValue(formatEventWindow(eventData)), inline: false }
    )
    .setTimestamp();

  if (eventData.url) {
    embed.addFields({ name: 'Link', value: `[Open event](${eventData.url})`, inline: false });
  }
  if (Array.isArray(eventData.categories) && eventData.categories.length > 0) {
    embed.addFields({ name: 'Categories', value: eventData.categories.join(', '), inline: false });
  }
  return embed;
}

async function fetchVatnzEvents() {
  const { data } = await axios.get(EVENT_CALENDAR_URL, { timeout: 15000 });
  return parseVatnzIcsEvents(data);
}

function createEventThreadService({
  eventThreads,
  messages,
  fetchDiscordChannel,
  getBookingChannel,
  getLogChannel,
  fetchBookingMessage,
  sendAuditLog,
  clearMentorTimers,
  clearExtensionSelectionTimer,
  rescheduleMentorTimers,
  isStaffMember
}) {
  let eventThreadCheckInterval = null;

  function getEventThreadState(uid) {
    return eventThreads.get(eventStateKey(uid));
  }

  function setEventThreadState(uid, state) {
    eventThreads.set(eventStateKey(uid), state);
  }

  function buildBookingEmbedFromRecord(booking, ownerId) {
    const embed = new EmbedBuilder()
      .setColor('#000000')
      .setTitle(booking.position || 'Booking')
      .addFields(
        { name: 'Date', value: cleanEmbedValue(booking.date), inline: false },
        { name: 'Start', value: cleanEmbedValue(String(booking.start)), inline: true },
        { name: 'End', value: cleanEmbedValue(String(booking.end)), inline: true },
        { name: 'Controller', value: `<@${ownerId}>`, inline: false }
      )
      .setTimestamp();

    if (booking.eventName) embed.addFields({ name: 'Event', value: cleanEmbedValue(booking.eventName), inline: false });
    if (Array.isArray(booking.extendedSectors) && booking.extendedSectors.length > 0) {
      embed.addFields({ name: 'Extended Sectors', value: booking.extendedSectors.map(s => sectorCodeMap[s] || s).join(', '), inline: false });
    }
    if (booking.mentorId) {
      embed.addFields({
        name: 'Mentor',
        value: booking.mentorApproved ? `<@${booking.mentorId}> Approved` : `<@${booking.mentorId}> (Pending Approval)`,
        inline: false
      });
    }
    return embed;
  }

  async function updateEventPromptMessage(state, content) {
    if (!state?.promptMessageId) return;
    const channel = await fetchDiscordChannel(state.promptChannelId || LOG_CHANNEL_ID, 'event prompt channel');
    if (!channel?.messages) return;

    try {
      const promptMessage = await channel.messages.fetch(state.promptMessageId);
      await promptMessage.edit({ content, components: [] });
    } catch (err) {
      console.warn(`Could not update event prompt ${state.promptMessageId}:`, err?.message || err);
    }
  }

  async function postEventThreadPrompt(eventData) {
    const existing = getEventThreadState(eventData.uid);
    if (existing?.status) return;

    const logChannel = await getLogChannel();
    if (!logChannel?.send) return;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`event_thread_create:${eventData.uid}`)
        .setLabel('Create thread')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`event_thread_decline:${eventData.uid}`)
        .setLabel('Decline')
        .setStyle(ButtonStyle.Secondary)
    );

    const promptMessage = await logChannel.send({
      content: STAFF_ROLE_ID ? `<@&${STAFF_ROLE_ID}> Event thread check required.` : 'Event thread check required.',
      embeds: [buildEventEmbed(eventData, 'Create Event Thread?')],
      components: [row]
    });

    setEventThreadState(eventData.uid, {
      status: 'prompted',
      promptMessageId: promptMessage.id,
      promptChannelId: logChannel.id,
      event: compactEventState(eventData),
      updatedAt: new Date().toISOString()
    });
  }

  async function moveBookingsIntoEventThread(eventData, thread) {
    const moved = [];
    const rawDB = messages.all();

    for (const entry of rawDB) {
      const ownerId = entry.key;
      const bookings = entry.data;
      if (!Array.isArray(bookings)) continue;

      let changed = false;
      for (const booking of bookings) {
        if (!bookingOverlapsEvent(booking, eventData)) continue;
        if (booking.threadId === thread.id || booking.channelId === thread.id) continue;

        const oldMessageId = booking.messageId;
        const oldChannelId = booking.channelId || process.env.CHANNEL_ID;
        const oldMessage = await fetchBookingMessage(booking);
        const embeds = oldMessage?.embeds?.length
          ? oldMessage.embeds.map(embed => EmbedBuilder.from(embed))
          : [buildBookingEmbedFromRecord(booking, ownerId)];

        const newMessage = await thread.send({ embeds });
        if (booking.mentorRequired && booking.mentorId && !booking.mentorApproved) {
          await newMessage.react(THUMBS_UP).catch(() => {});
        }

        if (oldMessage) {
          await oldMessage.delete().catch(err => {
            console.warn(`Could not delete moved booking message ${oldMessageId}:`, err?.message || err);
          });
        }

        clearMentorTimers(oldMessageId);
        clearExtensionSelectionTimer(oldMessageId);

        booking.previousMessageIds = [...(booking.previousMessageIds || []), oldMessageId].slice(-5);
        booking.messageId = newMessage.id;
        booking.channelId = thread.id;
        booking.threadId = thread.id;
        booking.eventUid = eventData.uid;
        booking.eventName = eventData.title;
        booking.guildId = thread.guild?.id || booking.guildId;
        rescheduleMentorTimers(ownerId, booking);

        moved.push({
          ownerId,
          oldMessageId,
          oldChannelId,
          newMessageId: newMessage.id,
          position: booking.position,
          date: booking.date,
          start: booking.start,
          end: booking.end
        });
        changed = true;

        await sendAuditLog({
          action: 'Booking Moved To Event Thread',
          actorLabel: 'System',
          targetUserId: ownerId,
          booking,
          reason: `Matched event ${eventData.title}`,
          fields: [
            { name: 'Event Thread', value: `<#${thread.id}>`, inline: true },
            { name: 'Old Channel', value: `<#${oldChannelId}>`, inline: true },
            { name: 'Old Message ID', value: oldMessageId, inline: false }
          ],
          color: '#0057B8'
        });
      }

      if (changed) messages.set(ownerId, bookings);
    }

    return moved;
  }

  async function createEventThreadForEvent(eventData, { actorId = null, source = 'auto' } = {}) {
    const existing = getEventThreadState(eventData.uid);
    if (existing?.status === 'created' && existing.threadId) {
      const existingThread = await fetchDiscordChannel(existing.threadId, 'event thread');
      if (existingThread) return { thread: existingThread, moved: [], alreadyCreated: true };
    }

    const bookingChannel = await getBookingChannel();
    if (!bookingChannel?.threads?.create) {
      throw new Error('Booking channel does not support public threads.');
    }

    const thread = await bookingChannel.threads.create({
      name: buildEventThreadName(eventData),
      autoArchiveDuration: 1440,
      type: ChannelType.PublicThread,
      reason: `VATNZ event thread for ${eventData.title}`
    });

    await thread.send({ embeds: [buildEventEmbed(eventData, 'Event Booking Thread')] });

    const moved = await moveBookingsIntoEventThread(eventData, thread);
    const updatedState = {
      ...(existing || {}),
      status: 'created',
      threadId: thread.id,
      threadChannelId: thread.id,
      parentChannelId: bookingChannel.id,
      event: compactEventState(eventData),
      source,
      createdBy: actorId,
      createdAt: new Date().toISOString(),
      movedBookings: moved
    };
    setEventThreadState(eventData.uid, updatedState);

    await updateEventPromptMessage(updatedState, `Event thread created: <#${thread.id}>`);
    await sendAuditLog({
      action: 'Event Thread Created',
      actorId,
      actorLabel: actorId ? null : 'System',
      reason: source === 'auto' ? 'Automatic Christchurch Control event thread' : 'Created from staff prompt',
      fields: [
        { name: 'Event', value: eventData.title, inline: false },
        { name: 'Time', value: formatEventWindow(eventData), inline: false },
        { name: 'Thread', value: `<#${thread.id}>`, inline: true },
        { name: 'Moved Bookings', value: String(moved.length), inline: true }
      ],
      color: '#0057B8'
    });

    return { thread, moved, alreadyCreated: false };
  }

  async function findMatchingEventThreadForBooking(booking) {
    const candidates = [];
    for (const entry of eventThreads.all()) {
      const state = entry.data;
      if (state?.status !== 'created' || !state.threadId || !state.event) continue;
      if (!bookingOverlapsEvent(booking, state.event)) continue;
      const eventTimes = getEventDateTimes(state.event);
      candidates.push({ state, start: eventTimes?.startNz?.toMillis() || 0 });
    }

    candidates.sort((a, b) => a.start - b.start);

    for (const candidate of candidates) {
      const thread = await fetchDiscordChannel(candidate.state.threadId, 'event thread');
      if (thread?.send) return { state: candidate.state, thread };
    }

    return null;
  }

  async function cleanupFinishedEventThreads() {
    const nowNz = DateTime.now().setZone('Pacific/Auckland');

    for (const entry of eventThreads.all()) {
      const uid = entry.key;
      const state = entry.data;
      if (!['created', 'delete_failed'].includes(state?.status) || !state.threadId || !state.event) continue;

      const eventTimes = getEventDateTimes(state.event);
      if (!eventTimes) continue;

      const deleteAfter = eventTimes.endNz.plus({ hours: 1 });
      if (nowNz < deleteAfter) continue;

      const updatedState = {
        ...state,
        status: 'deleted',
        deletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      let deleted = false;
      const thread = await fetchDiscordChannel(state.threadId, 'finished event thread');
      if (thread?.delete) {
        try {
          await thread.delete(`VATNZ event finished more than 1 hour ago: ${state.event.title}`);
          deleted = true;
        } catch (err) {
          console.warn(`Could not delete finished event thread ${state.threadId}:`, err?.message || err);
          updatedState.status = 'delete_failed';
          updatedState.deleteError = err?.message || String(err);
        }
      } else {
        updatedState.deleteNote = 'Thread was not found; treating it as already deleted.';
        deleted = true;
      }

      eventThreads.set(uid, updatedState);

      await sendAuditLog({
        action: deleted ? 'Event Thread Deleted' : 'Event Thread Delete Failed',
        actorLabel: 'System',
        reason: deleted ? 'Event ended more than 1 hour ago' : 'Discord thread deletion failed',
        fields: [
          { name: 'Event', value: state.event.title, inline: false },
          { name: 'Time', value: formatEventWindow(state.event), inline: false },
          { name: 'Thread ID', value: state.threadId, inline: true },
          { name: 'Delete After', value: deleteAfter.toFormat('dd LLL yyyy HH:mm ZZZZ'), inline: true }
        ],
        color: deleted ? '#D9534F' : '#FF9900'
      });
    }
  }

  async function handleEventThreadButton(interaction) {
    if (!isStaffMember(interaction.member)) {
      await interaction.reply({ content: 'You do not have permission to manage event threads.', ephemeral: true });
      return;
    }

    const createPrefix = 'event_thread_create:';
    const declinePrefix = 'event_thread_decline:';
    const isCreate = interaction.customId.startsWith(createPrefix);
    const isDecline = interaction.customId.startsWith(declinePrefix);
    const uid = isCreate
      ? interaction.customId.slice(createPrefix.length)
      : interaction.customId.slice(declinePrefix.length);
    const state = getEventThreadState(uid);
    const eventData = state?.event;

    if (!eventData || (!isCreate && !isDecline)) {
      await interaction.reply({ content: 'Could not find that event prompt.', ephemeral: true });
      return;
    }

    if (isCreate) {
      await interaction.deferReply({ ephemeral: true });
      try {
        const result = await createEventThreadForEvent(eventData, { actorId: interaction.user.id, source: 'staff' });
        await interaction.editReply({ content: `Event thread ready: <#${result.thread.id}>.` });
      } catch (err) {
        console.error('Could not create event thread:', err);
        await interaction.editReply({ content: 'Could not create the event thread. Check bot permissions and channel access.' });
      }
      return;
    }

    const updatedState = {
      ...state,
      status: 'declined',
      declinedBy: interaction.user.id,
      declinedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    setEventThreadState(uid, updatedState);
    await interaction.message.edit({ components: [] }).catch(() => {});
    await interaction.reply({ content: `Declined event thread for ${eventData.title}.`, ephemeral: true });
    await sendAuditLog({
      action: 'Event Thread Declined',
      actorId: interaction.user.id,
      fields: [
        { name: 'Event', value: eventData.title, inline: false },
        { name: 'Time', value: formatEventWindow(eventData), inline: false }
      ],
      color: '#666666'
    });
  }

  async function checkVatnzEventThreads() {
    await cleanupFinishedEventThreads();

    const eventsFromFeed = await fetchVatnzEvents();
    const upcoming = eventsFromFeed
      .filter(isEventWithinThreadWindow)
      .sort((a, b) => (getEventDateTimes(a)?.startNz?.toMillis() || 0) - (getEventDateTimes(b)?.startNz?.toMillis() || 0));

    for (const eventData of upcoming) {
      const existing = getEventThreadState(eventData.uid);
      if (existing?.status === 'created' && existing.threadId) {
        setEventThreadState(eventData.uid, { ...existing, event: compactEventState(eventData), updatedAt: new Date().toISOString() });
        const thread = await fetchDiscordChannel(existing.threadId, 'event thread');
        if (thread) await moveBookingsIntoEventThread(eventData, thread);
        continue;
      }

      if (isChristchurchControlEvent(eventData)) {
        if (existing?.status !== 'created') {
          await createEventThreadForEvent(eventData, { source: 'auto' });
        }
        continue;
      }

      if (existing?.status === 'declined') continue;
      if (existing?.status === 'prompted') {
        setEventThreadState(eventData.uid, { ...existing, event: compactEventState(eventData), updatedAt: new Date().toISOString() });
        continue;
      }

      await postEventThreadPrompt(eventData);
    }
  }

  function startEventThreadScheduler() {
    if (eventThreadCheckInterval) return;
    checkVatnzEventThreads().catch(err => console.warn(`Event thread check failed: ${summarizeError(err)}`));
    eventThreadCheckInterval = setInterval(() => {
      checkVatnzEventThreads().catch(err => console.warn(`Event thread check failed: ${summarizeError(err)}`));
    }, ONE_HOUR_MS);
  }

  return {
    getEventThreadState,
    setEventThreadState,
    buildBookingEmbedFromRecord,
    updateEventPromptMessage,
    postEventThreadPrompt,
    moveBookingsIntoEventThread,
    createEventThreadForEvent,
    findMatchingEventThreadForBooking,
    cleanupFinishedEventThreads,
    handleEventThreadButton,
    checkVatnzEventThreads,
    startEventThreadScheduler
  };
}

module.exports = {
  createEventThreadService,
  unfoldIcsLines,
  unescapeIcsValue,
  parseIcsDate,
  parseVatnzIcsEvents,
  fetchVatnzEvents,
  compactEventState,
  eventStateKey,
  formatEventWindow,
  isEventWithinThreadWindow,
  isChristchurchControlEvent,
  normalizeEventTitleForThreadName,
  ordinalDay,
  buildEventThreadName,
  buildEventEmbed
};
