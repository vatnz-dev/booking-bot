const axios = require('axios');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder
} = require('discord.js');

const {
  EVENT_CHECK_INTERVAL_MS,
  EVENT_CALENDAR_URL,
  EVENT_LOOKAHEAD_DAYS,
  EVENT_NOTIFICATION_LEAD_MS,
  EVENT_NOTIFICATIONS_ROLE_ID,
  LOG_CHANNEL_ID,
  THUMBS_UP,
  sectorCodeMap
} = require('../constants');
const { cleanEmbedValue } = require('../utils/format');
const { REFUSALS } = require('./access');
const { log } = require('../utils/log');
const {
  DateTime,
  bookingOverlapsEvent,
  formatBookingDateForDiscord,
  formatBookingEndForDiscord,
  formatBookingStartForDiscord,
  getEventDateTimes,
  toDiscordTimestamp
} = require('../utils/time');

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
  return [
    `Starts ${toDiscordTimestamp(eventTimes.startUtc, 'F')} (${toDiscordTimestamp(eventTimes.startUtc, 'R')})`,
    `Ends ${toDiscordTimestamp(eventTimes.endUtc, 'F')}`
  ].join('\n');
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

function eventTitleIncludesStartDate(eventTitle, eventTimes) {
  if (!eventTimes) return false;
  const normalized = String(eventTitle || '').toLowerCase().replace(/\s+/g, ' ');
  const day = eventTimes.startNz.day;
  const longMonth = eventTimes.startNz.toFormat('LLLL').toLowerCase();
  const shortMonth = eventTimes.startNz.toFormat('LLL').toLowerCase();
  const ordinal = ordinalDay(day).toLowerCase();
  const needles = [
    `${ordinal} ${longMonth}`,
    `${day} ${longMonth}`,
    `${ordinal} ${shortMonth}`,
    `${day} ${shortMonth}`
  ];
  return needles.some(needle => normalized.includes(needle));
}

function buildEventThreadName(eventData) {
  const eventTimes = getEventDateTimes(eventData);
  const eventTitle = normalizeEventTitleForThreadName(eventData.title);
  const suffix = eventTimes ? `${ordinalDay(eventTimes.startNz.day)} ${eventTimes.startNz.toFormat('LLLL')}` : 'event';
  if (eventTitleIncludesStartDate(eventTitle, eventTimes)) return eventTitle.slice(0, 100);
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

function getDiscordTimestamp(dateTime, style = 'F') {
  return toDiscordTimestamp(dateTime, style);
}

function getAirportPositionParts(position) {
  const match = String(position || '').toUpperCase().match(/^([A-Z]{4})_(DEL|GND|TWR|APP|DEP)$/);
  if (!match) return null;
  return { airport: match[1], suffix: match[2] };
}

function formatController(ownerId) {
  return ownerId ? ` <@${ownerId}>` : '';
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
  clearBookingReminderTimer = () => {},
  rescheduleMentorTimers,
  scheduleBookingReminder = () => {},
  access
}) {
  let eventThreadCheckInterval = null;

  function getEventThreadState(uid) {
    return eventThreads.get(eventStateKey(uid));
  }

  function setEventThreadState(uid, state) {
    eventThreads.set(eventStateKey(uid), state);
  }

  function buildBookingEmbedFromRecord(booking, ownerId) {
    const dateValue = formatBookingDateForDiscord(booking) || booking.date;
    const startValue = formatBookingStartForDiscord(booking) || String(booking.start);
    const endValue = formatBookingEndForDiscord(booking) || String(booking.end);

    const embed = new EmbedBuilder()
      .setColor('#000000')
      .setTitle(booking.position || 'Booking')
      .addFields(
        { name: 'Date', value: cleanEmbedValue(dateValue), inline: false },
        { name: 'Start', value: cleanEmbedValue(startValue), inline: true },
        { name: 'End', value: cleanEmbedValue(endValue), inline: true },
        { name: 'Controller', value: `<@${ownerId}>`, inline: false }
      )
      .setTimestamp();

    if (booking.eventName) embed.addFields({ name: 'Event', value: cleanEmbedValue(booking.eventName), inline: false });
    if (Array.isArray(booking.extendedSectors) && booking.extendedSectors.length > 0) {
      embed.addFields({ name: 'Extended Sectors', value: booking.extendedSectors.map(s => sectorCodeMap[s] || s).join(', '), inline: false });
    }
    if (booking.soloEndorsement?.scope) {
      embed.addFields({
        name: 'Solo Endorsement',
        value: `${booking.soloEndorsement.scope} (expires ${booking.soloEndorsement.endDate || booking.soloEndorsement.endDateISO})`,
        inline: false
      });
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

  async function ensureEventThreadName(thread, eventData) {
    const desiredName = buildEventThreadName(eventData);
    if (!thread?.setName || thread.name === desiredName) return;

    try {
      await thread.setName(desiredName, `VATNZ event title update for ${eventData.title}`);
    } catch (err) {
      log('warn', 'event_thread_rename_failed', { threadId: thread.id, error: err });
    }
  }

  async function updateEventPromptMessage(state, content) {
    if (!state?.promptMessageId) return;
    const channel = await fetchDiscordChannel(state.promptChannelId || LOG_CHANNEL_ID, 'event prompt channel');
    if (!channel?.messages) return;

    try {
      const promptMessage = await channel.messages.fetch(state.promptMessageId);
      await promptMessage.edit({ content, components: [] });
    } catch (err) {
      log('warn', 'event_prompt_update_failed', { messageId: state.promptMessageId, error: err });
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
      content: [...access.mentions('event-prompt'), 'Event thread check required.'].join(' '),
      embeds: [buildEventEmbed(eventData, 'Create Event Thread?')],
      components: [row]
    });

    setEventThreadState(eventData.uid, {
      ...(existing || {}),
      status: 'prompted',
      promptMessageId: promptMessage.id,
      promptChannelId: logChannel.id,
      event: compactEventState(eventData),
      updatedAt: new Date().toISOString()
    });
  }

  function getEventCoverage(eventData) {
    const airports = new Map();
    const enroute = [];

    for (const entry of messages.all()) {
      const ownerId = entry.key;
      const bookings = entry.data;
      if (!Array.isArray(bookings)) continue;

      for (const booking of bookings) {
        if (!bookingOverlapsEvent(booking, eventData)) continue;

        const position = String(booking.position || '').toUpperCase();
        const airportParts = getAirportPositionParts(position);
        if (airportParts) {
          if (!airports.has(airportParts.airport)) airports.set(airportParts.airport, []);
          airports.get(airportParts.airport).push(`${airportParts.suffix}${formatController(ownerId)}`);
          continue;
        }

        if (position.endsWith('_CTR') || position.endsWith('_FSS')) {
          const primary = `${sectorCodeMap[position] || position} (${position})${formatController(ownerId)}`;
          const extensions = Array.isArray(booking.extendedSectors) && booking.extendedSectors.length > 0
            ? ` - extensions: ${booking.extendedSectors.map(sector => `${sectorCodeMap[sector] || sector} (${sector})`).join(', ')}`
            : '';
          enroute.push(`${primary}${extensions}`);
        }
      }
    }

    return { airports, enroute };
  }

  function buildCoverageLines(coverage) {
    const airportLines = [...coverage.airports.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([airport, positions]) => `${airport}: ${[...new Set(positions)].join(', ')}`);

    const enrouteLines = [...new Set(coverage.enroute)].sort((a, b) => a.localeCompare(b));

    return {
      airports: airportLines.length > 0 ? airportLines.join('\n') : 'No airport/local coverage booked yet.',
      enroute: enrouteLines.length > 0 ? enrouteLines.join('\n') : 'No enroute/control coverage booked yet.'
    };
  }

  function buildEventCoverageEmbed(eventData) {
    const eventTimes = getEventDateTimes(eventData);
    const coverage = buildCoverageLines(getEventCoverage(eventData));
    const startValue = eventTimes
      ? `${toDiscordTimestamp(eventTimes.startUtc, 'F')} (${toDiscordTimestamp(eventTimes.startUtc, 'R')})`
      : 'Unknown start time';

    const embed = new EmbedBuilder()
      .setColor('#0057B8')
      .setTitle(`${eventData.title} Coverage`)
      .addFields(
        { name: 'Event Starts', value: startValue, inline: false },
        { name: 'Airports With Control', value: cleanEmbedValue(coverage.airports), inline: false },
        { name: 'Enroute / Control', value: cleanEmbedValue(coverage.enroute), inline: false }
      )
      .setTimestamp();

    if (eventData.url) {
      embed.addFields({ name: 'Event Link', value: `[Open event](${eventData.url})`, inline: false });
    }

    return embed;
  }

  function shouldPostEventCoverageNotification(eventData, state) {
    if (state?.notificationMessageId || state?.notificationDeletedAt) return false;
    const eventTimes = getEventDateTimes(eventData);
    if (!eventTimes) return false;

    const nowNz = DateTime.now().setZone('Pacific/Auckland');
    const notificationAt = eventTimes.startNz.minus({ milliseconds: EVENT_NOTIFICATION_LEAD_MS });
    return nowNz >= notificationAt && nowNz < eventTimes.endNz;
  }

  async function postEventCoverageNotification(eventData) {
    const state = getEventThreadState(eventData.uid) || {};
    if (!shouldPostEventCoverageNotification(eventData, state)) return;

    const channel = await getBookingChannel();
    if (!channel?.send) return;

    const content = EVENT_NOTIFICATIONS_ROLE_ID ? `<@&${EVENT_NOTIFICATIONS_ROLE_ID}>` : undefined;
    const sent = await channel.send({
      content,
      allowedMentions: EVENT_NOTIFICATIONS_ROLE_ID ? { roles: [EVENT_NOTIFICATIONS_ROLE_ID] } : { parse: [] },
      embeds: [buildEventCoverageEmbed(eventData)]
    });

    setEventThreadState(eventData.uid, {
      ...state,
      event: compactEventState(eventData),
      notificationMessageId: sent.id,
      notificationChannelId: channel.id,
      notificationPostedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    await sendAuditLog({
      action: 'Event Coverage Notification Posted',
      actorLabel: 'System',
      fields: [
        { name: 'Event', value: eventData.title, inline: false },
        { name: 'Message', value: `[Open message](https://discord.com/channels/${sent.guild?.id || '@me'}/${channel.id}/${sent.id})`, inline: false }
      ],
      color: '#0057B8'
    });
  }

  function shouldRefreshEventCoverageNotification(state) {
    return Boolean(state?.notificationMessageId && !state.notificationDeletedAt && state.event);
  }

  async function updateEventCoverageNotification(eventData, state = getEventThreadState(eventData?.uid)) {
    if (!shouldRefreshEventCoverageNotification(state)) return false;

    try {
      const channel = state.notificationChannelId
        ? await fetchDiscordChannel(state.notificationChannelId, 'event notifications channel')
        : await getBookingChannel();
      if (!channel?.messages) {
        setEventThreadState(state.event.uid, {
          ...state,
          notificationUpdateError: 'Notification channel was not found.',
          updatedAt: new Date().toISOString()
        });
        return false;
      }

      const message = await channel.messages.fetch(state.notificationMessageId);
      await message.edit({
        content: EVENT_NOTIFICATIONS_ROLE_ID ? `<@&${EVENT_NOTIFICATIONS_ROLE_ID}>` : undefined,
        allowedMentions: { parse: [] },
        embeds: [buildEventCoverageEmbed(eventData || state.event)]
      });

      const updatedState = {
        ...state,
        event: compactEventState(eventData || state.event),
        notificationUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      delete updatedState.notificationUpdateError;
      setEventThreadState((eventData || state.event).uid, updatedState);
      return true;
    } catch (err) {
      const updatedState = {
        ...state,
        notificationUpdateError: err?.message || String(err),
        updatedAt: new Date().toISOString()
      };
      if (err?.code === 10008) {
        updatedState.notificationDeletedAt = new Date().toISOString();
      }
      setEventThreadState(state.event.uid, updatedState);
      log('warn', 'event_coverage_update_failed', { messageId: state.notificationMessageId, error: err });
      return false;
    }
  }

  async function refreshEventCoverageNotificationsForBooking(booking) {
    if (!booking) return;

    for (const entry of eventThreads.all()) {
      const state = entry.data;
      if (!shouldRefreshEventCoverageNotification(state)) continue;
      if (!bookingOverlapsEvent(booking, state.event)) continue;
      await updateEventCoverageNotification(state.event, state);
    }
  }

  async function refreshActiveEventCoverageNotifications() {
    for (const entry of eventThreads.all()) {
      const state = entry.data;
      if (!shouldRefreshEventCoverageNotification(state)) continue;
      await updateEventCoverageNotification(state.event, state);
    }
  }

  async function cleanupFinishedEventCoverageNotifications() {
    const nowNz = DateTime.now().setZone('Pacific/Auckland');

    for (const entry of eventThreads.all()) {
      const uid = entry.key;
      const state = entry.data;
      if (!state?.notificationMessageId || state.notificationDeletedAt || !state.event) continue;

      const eventTimes = getEventDateTimes(state.event);
      if (!eventTimes || nowNz < eventTimes.endNz) continue;

      const retryState = {
        ...state,
        updatedAt: new Date().toISOString()
      };

      const channel = state.notificationChannelId
        ? await fetchDiscordChannel(state.notificationChannelId, 'event notifications channel')
        : await getBookingChannel();
      if (!channel?.messages) {
        eventThreads.set(uid, {
          ...retryState,
          notificationDeleteError: 'Notification channel was not found.'
        });
        continue;
      }

      try {
        const message = await channel.messages.fetch(state.notificationMessageId);
        await message.delete();
      } catch (err) {
        if (err?.code !== 10008) {
          log('warn', 'event_coverage_delete_failed', { messageId: state.notificationMessageId, error: err });
          eventThreads.set(uid, {
            ...retryState,
            notificationDeleteError: err?.message || String(err)
          });
          continue;
        }
      }

      const updatedState = {
        ...retryState,
        notificationDeletedAt: new Date().toISOString()
      };
      delete updatedState.notificationDeleteError;

      eventThreads.set(uid, updatedState);
      await sendAuditLog({
        action: 'Event Coverage Notification Deleted',
        actorLabel: 'System',
        fields: [
          { name: 'Event', value: state.event.title, inline: false },
          { name: 'Message ID', value: state.notificationMessageId, inline: true }
        ],
        color: '#D9534F'
      });
    }
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
        const bookingEmbed = buildBookingEmbedFromRecord(booking, ownerId);
        const oldEmbed = oldMessage?.embeds?.[0];
        if (oldEmbed?.thumbnail?.url) bookingEmbed.setThumbnail(oldEmbed.thumbnail.url);
        if (oldEmbed?.footer?.text) bookingEmbed.setFooter({ text: oldEmbed.footer.text });
        const embeds = [bookingEmbed];

        const newMessage = await thread.send({ embeds });
        if (booking.mentorRequired && booking.mentorId && !booking.mentorApproved) {
          await newMessage.react(THUMBS_UP).catch(() => {});
        }

        if (oldMessage) {
          await oldMessage.delete().catch(err => {
            log('warn', 'booking_message_delete_failed', { messageId: oldMessageId, reason: 'moved_to_thread', error: err });
          });
        }

        clearMentorTimers(oldMessageId);
        clearExtensionSelectionTimer(oldMessageId);
        clearBookingReminderTimer(oldMessageId);

        booking.previousMessageIds = [...(booking.previousMessageIds || []), oldMessageId].slice(-5);
        booking.messageId = newMessage.id;
        booking.channelId = thread.id;
        booking.threadId = thread.id;
        booking.eventUid = eventData.uid;
        booking.eventName = eventData.title;
        booking.guildId = thread.guild?.id || booking.guildId;
        rescheduleMentorTimers(ownerId, booking);
        scheduleBookingReminder(ownerId, booking);

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
      if (existingThread) {
        await ensureEventThreadName(existingThread, eventData);
        return { thread: existingThread, moved: [], alreadyCreated: true };
      }
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
          log('warn', 'event_thread_delete_failed', { threadId: state.threadId, error: err });
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
          { name: 'Delete After', value: toDiscordTimestamp(deleteAfter, 'F'), inline: true }
        ],
        color: deleted ? '#D9534F' : '#FF9900'
      });
    }
  }

  async function handleEventThreadButton(interaction) {
    const permission = access.can('event-thread', interaction.member);
    if (permission !== 'ok') {
      await interaction.reply({ content: REFUSALS[permission], ephemeral: true });
      await sendAuditLog({ action: 'Action Refused', actorId: interaction.user?.id, reason: REFUSALS[permission], fields: [{ name: 'Action', value: 'event-thread', inline: true }], color: '#D9534F' });
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
        log('error', 'event_thread_create_failed', { error: err });
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
    await cleanupFinishedEventCoverageNotifications();
    await cleanupFinishedEventThreads();

    const eventsFromFeed = await fetchVatnzEvents();
    const upcoming = eventsFromFeed
      .filter(isEventWithinThreadWindow)
      .sort((a, b) => (getEventDateTimes(a)?.startNz?.toMillis() || 0) - (getEventDateTimes(b)?.startNz?.toMillis() || 0));

    for (const eventData of upcoming) {
      let existing = getEventThreadState(eventData.uid);
      await postEventCoverageNotification(eventData);
      existing = getEventThreadState(eventData.uid);

      if (existing?.status === 'created' && existing.threadId) {
        setEventThreadState(eventData.uid, { ...existing, event: compactEventState(eventData), updatedAt: new Date().toISOString() });
        const thread = await fetchDiscordChannel(existing.threadId, 'event thread');
        if (thread) {
          await ensureEventThreadName(thread, eventData);
          await moveBookingsIntoEventThread(eventData, thread);
        }
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
    checkVatnzEventThreads().catch(err => log('warn', 'event_thread_check_failed', { error: err }));
    eventThreadCheckInterval = setInterval(() => {
      checkVatnzEventThreads().catch(err => log('warn', 'event_thread_check_failed', { error: err }));
    }, EVENT_CHECK_INTERVAL_MS);
  }

  return {
    getEventThreadState,
    setEventThreadState,
    buildBookingEmbedFromRecord,
    buildEventCoverageEmbed,
    postEventCoverageNotification,
    updateEventCoverageNotification,
    refreshEventCoverageNotificationsForBooking,
    refreshActiveEventCoverageNotifications,
    cleanupFinishedEventCoverageNotifications,
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
  eventTitleIncludesStartDate,
  buildEventThreadName,
  buildEventEmbed,
  getDiscordTimestamp
};
