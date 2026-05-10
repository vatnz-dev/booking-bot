(async () => {
  require('dotenv').config();

  const Database = require("easy-json-database")
  const event = new Database('./event.json')
  const messages = new Database("./messages.json");
  const eventclose = new Database('./eventclose.json')
  const eventThreads = new Database('./eventthreads.json')
  const cheerio = require('cheerio');
  const { DateTime } = require('luxon');
  const axios = require('axios');
  const dns = require('dns');
  const events = require('events');
  const { exec } = require("child_process");
  const Discord = require("discord.js");
  const buttonCooldowns = new Map();
  const {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    EmbedBuilder,
    ButtonBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    PermissionFlagsBits,
    ActivityType,
    ButtonStyle,
    ChannelType
  } = require("discord.js");
  const fs = require('fs');
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  dns.setDefaultResultOrder?.('ipv4first');
  const trafficCache = new Map();
  const syncCommands = require('discord-sync-commands');
  const mentorTagTimeouts = new Map();
  const mentorApprovalTimeouts = new Map();
  const extensionSelectionTimeouts = new Map();
  const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
  const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
  const EVENT_CALENDAR_URL = process.env.EVENT_CALENDAR_URL || 'https://www.vatnz.net/events/calendar/vatnz-lite.ics';
  const EVENT_LOOKAHEAD_DAYS = 7;
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const MENTOR_TAG_TIMEOUT_MS = 5 * 60 * 1000;
  const MENTOR_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
  let eventThreadCheckInterval = null;
  let bookingCleanupInterval = null;

  const ratingRoleIds = {
    S1: '1424663440638611536',
    S2: '1424663463564808213',
    S3: '1424663506967592970',
    I3: '1424663527670677504',
    C1: '1427191104373264415',
    C3: '1427191215689961473',
    I1: '1427191337458864158'
  };
  const THUMBS_UP = '\u{1F44D}';

  let s4d = {
    Discord,
    fire: null,
    joiningMember: null,
    reply: null,
    player: null,
    manager: null,
    Inviter: null,
    message: null,
    notifer: null,
    checkMessageExists() {
      if (!client) throw new Error('You cannot perform message operations without a Discord.js client')
      if (!client.readyTimestamp) throw new Error('You cannot perform message operations while the bot is not connected to the Discord API')
    }
  };

  function isStaffMember(member) {
    return Boolean(member?.roles?.cache?.has(STAFF_ROLE_ID));
  }

  function cleanEmbedValue(value, fallback = 'N/A') {
    const text = value === undefined || value === null || value === '' ? fallback : String(value);
    return text.length > 1024 ? `${text.slice(0, 1021)}...` : text;
  }

  function summarizeError(err) {
    if (!err) return 'Unknown error';
    const code = err.code || err.cause?.code;
    const status = err.response?.status ? `HTTP ${err.response.status}` : null;
    const url = err.config?.url;
    const message = err.message || err.cause?.message || String(err);
    return [code, status, message, url].filter(Boolean).join(' - ');
  }

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

  function formatAuditUser(userId, fallback = 'System') {
    return userId ? `<@${userId}> (${userId})` : fallback;
  }

  function addAuditField(fields, name, value, inline = false) {
    if (value === undefined || value === null || value === '') return;
    fields.push({ name, value: cleanEmbedValue(value), inline });
  }

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

  function parseDdMm(dateStr) {
    if (!/^\d{2}\/\d{2}$/.test(String(dateStr))) return null;
    const [day, month] = String(dateStr).split('/').map(Number);
    if (month < 1 || month > 12) return null;
    const check = DateTime.fromObject({ year: DateTime.now().setZone('Pacific/Auckland').year, month, day }, { zone: 'Pacific/Auckland' });
    if (!check.isValid) return null;
    return { day, month };
  }

  function parseHhmm(time) {
    const raw = String(time).padStart(4, '0');
    if (!/^\d{4}$/.test(raw)) return null;
    const hour = Number(raw.slice(0, 2));
    const minute = Number(raw.slice(2));
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { raw, hour, minute };
  }

  function buildNzDateTime(dateStr, timeStr, year) {
    const date = parseDdMm(dateStr);
    const time = parseHhmm(timeStr);
    if (!date || !time) return null;

    const value = DateTime.fromObject(
      { year, month: date.month, day: date.day, hour: time.hour, minute: time.minute },
      { zone: 'Pacific/Auckland' }
    );

    return value.isValid ? value : null;
  }

  function getBookingIntervalNz(booking, year) {
    const startNz = buildNzDateTime(booking?.date, booking?.start, year);
    const endNz = buildNzDateTime(booking?.date, booking?.end, year);
    if (!startNz || !endNz) return null;
    return { startNz, endNz };
  }

  function getEventDateTimes(eventData) {
    const startUtc = DateTime.fromISO(eventData?.startUtcISO || eventData?.start, { zone: 'utc' });
    const endUtc = DateTime.fromISO(eventData?.endUtcISO || eventData?.end, { zone: 'utc' });
    if (!startUtc.isValid || !endUtc.isValid) return null;
    return {
      startUtc,
      endUtc,
      startNz: startUtc.setZone('Pacific/Auckland'),
      endNz: endUtc.setZone('Pacific/Auckland')
    };
  }

  function bookingOverlapsEvent(booking, eventData) {
    const eventTimes = getEventDateTimes(eventData);
    if (!eventTimes) return false;
    const bookingTimes = getBookingIntervalNz(booking, eventTimes.startNz.year);
    if (!bookingTimes) return false;
    return bookingTimes.startNz < eventTimes.endNz && bookingTimes.endNz > eventTimes.startNz;
  }

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

  async function fetchVatnzEvents() {
    const { data } = await axios.get(EVENT_CALENDAR_URL, { timeout: 15000 });
    return parseVatnzIcsEvents(data);
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

  function getEventThreadState(uid) {
    return eventThreads.get(eventStateKey(uid));
  }

  function setEventThreadState(uid, state) {
    eventThreads.set(eventStateKey(uid), state);
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
    // This is intentionally based on the VATNZ event title, not NZCH bookings or positions.
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

const sectorAerodromeMap = {
  "NZCH-S_CTR": ["NZQN", "NZDN", "NZNV"],
  "NZCH-T_CTR": ["NZWN", "NZWB", "NZNS"],
  "NZAA_CTR": ["NZAA", "NZWP", "NZHN"],
  "NZCH-B_CTR": ["NZRO", "NZTG", "NZGS"],
  "NZCH-K_CTR": ["NZCH"],
  "NZOH_CTR": ["NZOH", "NZPM", "NZNR"],
  "NZAA-R_CTR": ["NZHN", "NZNP"],
  "NZWN_APP": ["NZWN", "NZWB"],
  "NZOH_APP": ["NZOH", "NZPM"],
  "NZAA_APP": ["NZAA", "NZWP"]
};

const sectorCodeMap = {
  "NZAA_CTR": "OCR",
  "NZCH-B_CTR": "BAY",
  "NZOH_CTR": "OHA",
  "NZCH-K_CTR": "KAI",
  "NZCH-T_CTR": "NAK",
  "NZCH-S_CTR": "STH",
  "NZAA-R_CTR": "RAN"
};

function resolveAerodromes(position) {
  if (sectorAerodromeMap[position]) return sectorAerodromeMap[position];
  const match = position.match(/^([A-Z]{4})_(APP|TWR|GND|DEL)$/);
  if (match) return [match[1]];
  return [];
}

function getPreviousWeekNZ(dateStr, startHHMM = '0000') {
  const [day, month] = dateStr.split('/').map(Number);
  const hhmm = String(startHHMM).padStart(4, '0');
  const hour = Number(hhmm.slice(0, 2));
  const minute = Number(hhmm.slice(2));
  const nowNZ = DateTime.now().setZone('Pacific/Auckland');

  let bookingDate = DateTime.fromObject(
    { year: nowNZ.year, month, day, hour, minute },
    { zone: 'Pacific/Auckland' }
  );

  if (!bookingDate.isValid) {
    return nowNZ.minus({ days: 7 }).toFormat('yyyy-MM-dd');
  }

  if (bookingDate < nowNZ) {
    bookingDate = bookingDate.plus({ years: 1 });
  }

  return bookingDate.minus({ days: 7 }).toFormat('yyyy-MM-dd');
}

function getControllerTier(member) {
  if (member.roles.cache.has(ratingRoleIds.I3)) return 'I3';
  if (member.roles.cache.has(ratingRoleIds.I1)) return 'I1';
  if (member.roles.cache.has(ratingRoleIds.C3)) return 'C3';
  if (member.roles.cache.has(ratingRoleIds.C1)) return 'C1';
  if (member.roles.cache.has(ratingRoleIds.S3)) return 'S3';
  if (member.roles.cache.has(ratingRoleIds.S2)) return 'S2';
  if (member.roles.cache.has(ratingRoleIds.S1)) return 'S1';
  return 'UNRATED';
}

function getPositionType(position) {
  if (position.endsWith('_CTR')) return 'CTR';
  if (position.endsWith('_APP')) return 'APP';
  if (/_((DEL)|(GND)|(TWR))$/.test(position)) return 'LOCAL';
  return 'OTHER';
}

function evaluateBookingEligibility(member, position) {
  const tier = getControllerTier(member);
  const type = getPositionType(position);

  if (['C1', 'C3', 'I1', 'I3'].includes(tier)) {
    return { allowed: true, mentorRequired: false };
  }

  if (tier === 'S3') {
    if (type === 'CTR') return { allowed: true, mentorRequired: true };
    if (type === 'APP' || type === 'LOCAL') return { allowed: true, mentorRequired: false };
    return { allowed: false, reason: '❌ S3 can only book DEL/GND/TWR/APP directly. CTR requires mentor approval.' };
  }

  if (tier === 'S2') {
    if (type === 'CTR') return { allowed: false, reason: '❌ S2 cannot book CTR positions.' };
    if (type === 'APP') return { allowed: true, mentorRequired: true };
    if (type === 'LOCAL') return { allowed: true, mentorRequired: false };
    return { allowed: false, reason: '❌ S2 can only book DEL/GND/TWR directly, or APP with mentor approval.' };
  }

  if (tier === 'S1' || tier === 'UNRATED') {
    if (type === 'CTR') return { allowed: false, reason: '❌ S1/unrated controllers cannot book CTR positions.' };
    if (type === 'APP') return { allowed: false, reason: '❌ S1/unrated controllers cannot book APP positions.' };
    if (type === 'LOCAL') return { allowed: true, mentorRequired: true };
    return { allowed: false, reason: '❌ S1/unrated controllers can only book DEL/GND/TWR with mentor approval.' };
  }

  return { allowed: false, reason: '❌ Could not determine your booking permissions.' };
}

function hhmmToClock(hhmm) {
  const raw = String(hhmm).padStart(4, '0');
  return `${raw.slice(0, 2)}:${raw.slice(2)}`;
}

function buildUtcWindowFromNz(date, start = '0000', end = '2359') {
  const [year, month, day] = String(date).split('-').map(Number);
  const startRaw = String(start).padStart(4, '0');
  const endRaw = String(end).padStart(4, '0');

  const startHour = Number(startRaw.slice(0, 2));
  const startMinute = Number(startRaw.slice(2));
  const endHour = Number(endRaw.slice(0, 2));
  const endMinute = Number(endRaw.slice(2));

  const fromNz = DateTime.fromObject(
    { year, month, day, hour: startHour, minute: startMinute },
    { zone: 'Pacific/Auckland' }
  );
  const toNz = DateTime.fromObject(
    { year, month, day, hour: endHour, minute: endMinute },
    { zone: 'Pacific/Auckland' }
  );

  if (!fromNz.isValid || !toNz.isValid) {
    return null;
  }

  return {
    fromUtc: fromNz.toUTC().toFormat("yyyy-MM-dd'T'HH:mm"),
    toUtc: toNz.toUTC().toFormat("yyyy-MM-dd'T'HH:mm")
  };
}

async function getTrafficData(icao, date, start = '0000', end = '2359') {
  const utcWindow = buildUtcWindowFromNz(date, start, end);
  if (!utcWindow) {
    return { icao, arrivals: 0, departures: 0 };
  }

  const { fromUtc, toUtc } = utcWindow;
  const key = `${icao}_${fromUtc}_${toUtc}`;
  if (trafficCache.has(key)) return trafficCache.get(key);

  const url = `https://statsim.net/events/custom/${encodeURIComponent(fromUtc)}/${encodeURIComponent(toUtc)}/${icao}`;
  const { data: html } = await axios.get(url);
  const $ = cheerio.load(html);
  const text = $('body').text();

  const arrivals = parseInt(text.match(/Arrivals:\s*(\d+)/)?.[1] || 0);
  const departures = parseInt(text.match(/Departures:\s*(\d+)/)?.[1] || 0);
  const result = { icao, arrivals, departures };

  trafficCache.set(key, result);
  return result;
}

async function getSectorTraffic(sector, date, start = '0000', end = '2359') {
  const aerodromes = sectorAerodromeMap[sector] || [];

  const promises = aerodromes.map(icao =>
    getTrafficData(icao, date, start, end).catch(() => ({ arrivals: 0, departures: 0 }))
  );

  const results = await Promise.all(promises);

  let arrivals = 0;
  let departures = 0;

  for (const r of results) {
    arrivals += r.arrivals;
    departures += r.departures;
  }

  return {
    sectorCode: sectorCodeMap[sector] || sector,
    arrivals,
    departures,
    total: arrivals + departures
  };
}

async function formatAerodromeTraffic(position, date, start = '0000', end = '2359') {
  const aerodromes = resolveAerodromes(position);

  const promises = aerodromes.map(icao =>
    getTrafficData(icao, date, start, end).catch(() => ({ icao, arrivals: 0, departures: 0 }))
  );

  const results = await Promise.all(promises);

  let out = `📊 **Expected Traffic (based on ${date} ${hhmmToClock(start)}-${hhmmToClock(end)})**\n`;

  for (const r of results) {
    out += `• **${r.icao}** — ${r.arrivals} arrivals / ${r.departures} departures\n`;
  }

  return out;
}

async function formatSectorTraffic(sectors, date, start = '0000', end = '2359') {
  let out = `📊 **Expected Traffic (based on ${date} ${hhmmToClock(start)}-${hhmmToClock(end)})**\n`;
  for (const sector of sectors) {
    const t = await getSectorTraffic(sector, date, start, end);
    out += `• **${t.sectorCode}** — ${t.total} movements (${t.arrivals} arrivals / ${t.departures} departures)\n`;
  }
  return out;
}

  const { Client, GatewayIntentBits, Partials } = require('discord.js');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User]
  });

  client.once('clientReady', () => {
    console.log(`${client.user.tag} is alive!`);
    startBookingCleanupScheduler();
    startEventThreadScheduler();
  });

  client.login(process.env.DISCORD_TOKEN);

  client.on('clientReady', async () => {
    client.user.setPresence({ status: "online", activities: [{ name: 'ATC Bookings', type: ActivityType.Watching }] });
  });

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
        content: targetUserId === userId ? '📭 You have no current bookings.' : `📭 <@${targetUserId}> has no current bookings.`,
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
      content: targetUserId === userId ? '🗑️ Select a booking to delete:' : `🗑️ Select a booking to delete for <@${targetUserId}>:`,
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

  client.on('interactionCreate', async (interaction) => {
    try {

  // Slash commands
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
      case 'mentor':
        await handleMentor(interaction);
        break;
      case 'openeventposition':
        await handleOpenEventPosition(interaction);
        break;
      case 'viewbookings':
        await handleViewBookings(interaction);
        break;
    }
    return;
  }

  // Buttons
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

  // Select menus
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

  // Modals (forms)
  if (interaction.isModalSubmit()) {
    switch (interaction.customId) {
      case 'plan':
        await handlePlan(interaction);
        break;
    }
    return;
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
        console.warn(`⚠️ Could not DM user ${ownerId} with fallback extension stats:`, err?.message || err);
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
      console.warn(`⚠️ Could not auto-delete booking message ${messageId}:`, err?.message || err);
    }

    if (dmText) {
      try {
        const user = await client.users.fetch(entry.ownerId);
        await user.send({ content: dmText });
      } catch (err) {
        console.warn(`⚠️ Could not DM user ${ownerId} about auto-deletion:`, err?.message || err);
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

  client.on('messageReactionAdd', async (reaction, user) => {
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
      newEmbed.addFields({ name: 'Mentor', value: `<@${booking.mentorId}> ✅ Approved`, inline: false });
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
      console.warn('⚠️ Failed to process mentor approval reaction:', err?.message || err);
    }
  });



  function convertToUTC(dateStr, timeStr) {
    const DateTime = require('luxon').DateTime;

    const [day, month] = dateStr.split('/').map(Number);
    let year = new Date().getFullYear();

    const hours = timeStr.slice(0, 2);
    const minutes = timeStr.slice(2);

    let nzDate = DateTime.fromISO(`${year}-${month}-${day}T${hours}:${minutes}:00`).setZone('Pacific/Auckland');
    const nowNZ = DateTime.now().setZone('Pacific/Auckland');

    if (nzDate < nowNZ) {
      nzDate = nzDate.plus({ years: 1 });
    }

    return nzDate.toISO();
  }

  async function getVatsimId(discordId) {
    try {
      const url = `https://api.vatsim.net/v2/members/discord/${discordId}`;
      const response = await axios.get(url);

      if (!response.data || !response.data.user_id) {
        console.error('❌ VATSIM ID not found in response.');
        return null;
      }

      return response.data.user_id;
    } catch (error) {
      console.error('❌ Failed to fetch VATSIM ID:', error.response?.status || error.message);
      return null;
    }
  }

  /*
  // Send booking to VATSIM API
  async function sendBooking({ callsign, cid, start, end }) {
    try {
      const payload = {
        callsign,
        cid,
        type: "booking",
        start,
        end,
        division: "TBC",
        subdivision: "TBC"
      };
      const response = await axios.post('https://atc-bookings.vatsim.net/api/booking', payload);
      return response.data.id; // booking ID from VATSIM
    } catch (error) {
      console.error('Booking failed:', error.response?.data);
      return null;
    }
  }
  */
  async function handleDeleteBookingSelect(interaction) {
    const userId = String(interaction.member.user.id);
    const [targetUserFromValue, selectedIndexFromValue] = String(interaction.values[0]).includes('|')
      ? interaction.values[0].split('|')
      : [userId, interaction.values[0]];
    const selectedIndex = parseInt(selectedIndexFromValue, 10);
    const targetUserId = String(targetUserFromValue);
    const staff = isStaffMember(interaction.member);

    if (targetUserId !== userId && !staff) {
      await interaction.update({
        content: 'You can only delete your own bookings.',
        components: [],
        ephemeral: true
      });
      return;
    }

    const userBookings = messages.get(targetUserId);

    if (!Array.isArray(userBookings) || !userBookings[selectedIndex]) {
      await interaction.update({
        content: '❌ Booking not found.',
        components: [],
        ephemeral: true
      });
      return;
    }

    const booking = userBookings[selectedIndex];
    /*
      // --- Delete booking from VATSIM API if bookingvatid exists ---
      if (booking.bookingvatid) {
        try {
          await axios.delete(`https://atc-bookings.vatsim.net/api/booking/${booking.bookingvatid}`);
        } catch (error) {
          console.error(`⚠️ Failed to delete VATSIM booking ${booking.bookingvatid}:`, error.response?.status);
        }
      }
    */

    userBookings.splice(selectedIndex, 1);
    messages.set(targetUserId, userBookings);
    clearMentorTimers(booking.messageId);
    clearExtensionSelectionTimer(booking.messageId);


    try {
      const messageToDelete = await fetchBookingMessage(booking);
      if (messageToDelete) await messageToDelete.delete();
    } catch (err) {
      console.error(`⚠️ Could not delete message ${booking.messageId}:`, err);
    }

    await sendAuditLog({
      action: targetUserId === userId ? 'Booking Deleted' : 'Staff Deleted Booking',
      actorId: userId,
      targetUserId,
      booking,
      reason: targetUserId === userId ? 'Controller deleted their own booking' : 'Staff deleted another controller booking',
      color: targetUserId === userId ? '#D9534F' : '#FF9900'
    });

    await interaction.update({
      content: targetUserId === userId
        ? `✅ Booking for ${booking.position} on ${booking.date} at ${booking.start} has been deleted.`
        : `✅ Booking for ${booking.position} on ${booking.date} at ${booking.start} has been deleted for <@${targetUserId}>.`,
      components: [],
      ephemeral: true
    });
  };

  client.on('clientReady', async () => {
    const managedEventPositions = [
      'NZZO-E_FSS', 'NZAA-R_CTR', 'NZCH-D_CTR', 'NZAA_DEP', 'NZCH_DEP',
      'NZWN_DEP', 'NSTU_TWR', 'NZMF_TWR', 'NZPP_TWR', 'NZFX_GND',
      'NZQN_GND', 'NCRG_DEL', 'NZFX_DEL'
    ];
    for (const position of managedEventPositions) {
      if (event.get(position) === undefined) {
        event.set(position, '0/0');
      }
    }
    var plan_embed = new Discord.EmbedBuilder();
    plan_embed.setColor('#000000');
    plan_embed.setTitle(String('Book A Controlling Session'))
    plan_embed.setDescription(String('Controllers may post in this channel indicating that they intend to log onto a specific callsign at a specific time. This channel does not act as a booking system, but merely a heads-up that you intend to log on around that time.'));
    plan_embed.addFields(
      {
        name: 'Under mentoring?',
        value: 'You must run the /mentor command and put your Mentor/Instructor\'s first and last name in your post. If you are logging on and utilising your Solo Endorsement, you must also state this in your controller info.',
        inline: true
      },
      {
        name: 'More Information?',
        value: 'https://www.vatnz.net/vatnz/policies/atc-policy/',
        inline: false
      }
    );
    let plan = new ButtonBuilder()
    const bookingChannel = await getBookingChannel();
    if (bookingChannel?.send) {
      plan.setCustomId('plan'); plan.setStyle(ButtonStyle.Secondary); plan.setLabel('Book Controlling Session'); bookingChannel.send({
        content: String(' '),
        components: [new ActionRowBuilder().addComponents(plan)],
        embeds: [plan_embed]
      });
    }

  });

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
      const eventName = i.fields.getTextInputValue('event');


      const autoInheritanceMap = {
        "NZAA_CTR": ["NZCH-B_CTR"],
        "NZCH-T_CTR": ["NZOH_CTR"],
        "NZCH-S_CTR": ["NZCH-K_CTR"]
      };

      const fssPositions = ['NTTT_FSS', 'NZCM_FSS', 'NZZO-TSN_FSS', 'NZZO_FSS', 'NZZO-E_FSS'];
      const fssRoleId = '1424849958074454146';

      const roleMap = {
        '1424663440638611536': 'S1 - Developing Controller',
        '1424663463564808213': 'S2 - Aerodrome Controller',
        '1424663506967592970': 'S3 - Terminal Controller',
        '1424663527670677504': 'I3 - Senior Instructor',
        '1427191104373264415': 'C1 - Enroute Controller',
        '1427191215689961473': 'C3 - Senior Controller',
        '1427191337458864158': 'I1 - Instructor'
      };

      if (posRaw !== pos) return i.editReply({ content: '❌ Position must be in ALL CAPS.', ephemeral: true });
      if (isNaN(start) || isNaN(end)) return i.editReply({ content: '❌ Start and End times must be valid numbers.', ephemeral: true });

      const callsignRegex = /^(?:[A-Z]{4}_[A-Z]{3}|NZCH-[A-Z]_CTR)$/;
      if (!callsignRegex.test(pos)) {
        await i.editReply({
          content: '❌ Invalid callsign format. Must be XXXX_XXX or NZCH-X_CTR, no numbers allowed.',
          ephemeral: true
        });
        return;
      }


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
          content: '❌ Start and End times must be valid 24-hour times (HHMM).',
          ephemeral: true
        });
        return;
      }

      const starts = parseInt(startRaw, 10);
      const ends = parseInt(endRaw, 10);

      if (starts >= ends) {
        await i.editReply({
          content: '❌ Start time must be before End time.',
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
          content: '❌ Date must be valid and in format DD/MM (e.g., 05/12).',
          ephemeral: true
        });
        return;
      }

      const unlockedDate = event.get(pos);
      if (unlockedDate && unlockedDate !== '0/0' && unlockedDate !== date) {
        return i.editReply({ content: `❌ This position is locked. It is only unlocked for ${unlockedDate}.`, ephemeral: true });
      }

      if (fssPositions.includes(pos) && !member.roles.cache.has(fssRoleId)) {
        return i.editReply({ content: '❌ You do not have the Oceanic Endorsement required to book this FSS position.', ephemeral: true });
      }

      const eligibility = evaluateBookingEligibility(member, pos);
      if (!eligibility.allowed) {
        return i.editReply({ content: eligibility.reason, ephemeral: true });
      }
      const mentorRequired = eligibility.mentorRequired === true;

      const rawDB = messages.all();
      const isCTR = pos.endsWith("_CTR") && pos !== "NZAA-R_CTR";
      const extendedSectors = isCTR ? [...(autoInheritanceMap[pos] || [])] : [];
      const newBookingSectors = [pos, ...extendedSectors];

      for (const entry of rawDB) {
        const bookings = entry.data;
        if (!Array.isArray(bookings)) continue;

        for (const b of bookings) {
          if (b.date !== date || b.position !== pos) continue;
          const bStart = parseInt(b.start);
          const bEnd = parseInt(b.end);
          const timeOverlap = !(end <= bStart || start >= bEnd);
          if (timeOverlap) {
            return i.editReply({ content: '❌ This time slot is already booked for that position.', ephemeral: true });
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
              console.warn(`⚠️ Could not update embed for booking ${b.messageId}`);
            }

            try {
              const user = await client.users.fetch(otherUserId);
              const reason = otherUserId === userId
                ? 'You booked a new session that overrides these sectors.'
                : 'Another controller booked or inherited these sectors.';

              await user.send({
                content: `📭 One or more extended sectors were removed from your booking.`,
                embeds: [
                  new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('Extended Sectors Removed')
                    .setDescription(
                      `The following sectors were removed from your booking on **${b.date}**:\n` +
                      removedSectors.map(s => `• ${sectorCodeMap[s] || s}`).join('\n') +
                      `\n\nReason: ${reason}`
                    )
                    .setFooter({ text: 'VATNZ Booking System' })
                ]
              });
            } catch (err) {
              console.warn(`⚠️ Could not DM user ${otherUserId}: ${err}`);
            }

            messages.set(otherUserId, bookings);
          }
        }
      }

      const startUTC = convertToUTC(date, String(start).padStart(4, '0'));
      const endUTC = convertToUTC(date, String(end).padStart(4, '0'));

      const vatsimId = await getVatsimId(userId);
      if (!vatsimId) {
        return i.editReply({ content: '❌ Could not retrieve your VATSIM ID. Please ensure your Discord is linked Here: https://community.vatsim.net/', ephemeral: true });
      }

      /*// --- Send booking to VATSIM API ---
      const bookingvatid = await sendBooking({
        callsign: pos,
        cid: vatsimId,
        start: startUTC,
        end: endUTC
      });
      
      if (!bookingvatid) {
        return i.reply({ content: '❌ Booking failed. Please try again later.', ephemeral: true });
      }
        */

      const bookingEmbed = new EmbedBuilder()
        .setColor('#000000')
        .setTitle(pos)
        .setTimestamp(new Date())
        .addFields(
          { name: 'Date', value: date, inline: false },
          { name: 'Start', value: String(start), inline: true },
          { name: 'End', value: String(end), inline: true },
          { name: 'Controller', value: `<@${userId}>`, inline: false }
        )
        .setThumbnail(member.user.displayAvatarURL({ format: "png" }));

      const matchingEventThread = await findMatchingEventThreadForBooking({ position: pos, date, start, end });
      const matchedEventName = matchingEventThread?.state?.event?.title || null;

      if (eventName || matchedEventName) {
        bookingEmbed.addFields({ name: 'Event', value: eventName || matchedEventName, inline: false });
      }
      if (extendedSectors.length > 0) {
        const display = extendedSectors.map(s => sectorCodeMap[s] || s);
        bookingEmbed.addFields({ name: 'Extended Sectors', value: display.join(', '), inline: false });
      }

      for (const [roleId, label] of Object.entries(roleMap)) {
        if (member.roles.cache.has(roleId)) {
          bookingEmbed.setFooter({ text: label });
          break;
        }
      }

      const channel = matchingEventThread?.thread || await getBookingChannel();
      if (!channel?.send) {
        return i.editReply({ content: '❌ Could not find the booking channel. Check CHANNEL_ID.', ephemeral: true });
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
        eventName: eventName || matchedEventName || null,
        extendedSectors,
        awaitingExtensionSelection: false,
        mentorRequired,
        mentorId: null,
        mentorApproved: false,
        startUtc: startUTC,
        endUtc: endUTC,
        createdAt: new Date().toISOString(),
        // bookingvatid
      };
      userBookings.push(createdBooking);
      messages.set(userId, userBookings);

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
      const mentorNotice = mentorRequired
        ? '\nMentor required. If you do not tag a mentor within 5 minutes, this booking will be auto-deleted.'
        : '';

if (isCTR) {
  const allExtendable = [
    'NZCH-B_CTR', 'NZOH_CTR', 'NZCH-K_CTR',
    'NZCH-S_CTR', 'NZCH-T_CTR', 'NZAA_CTR'
  ];

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

  const availableSectors = allExtendable.filter(sector =>
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
          content: '⏳ Please wait before clicking again.',
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
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('event')
                .setLabel('Is This An Event? If So, What Event?')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(45)
                .setRequired(false)
            )
          );


        await i.showModal(planModal);
      }
    }
  }


  syncCommands(client, [
    {
      name: 'viewbookings',
      description: 'View your controller bookings.'
    },
    {
      name: 'deletebookings',
      description: 'Delete your controller bookings.',
      options: [
        {
          type: 6,
          name: 'controller',
          description: 'Staff only: delete another controller booking.',
          required: false
        }
      ]
    },
    {
      name: 'expectedtraffic',
      description: 'Check expected traffic using previous-week StatSim data.',
      options: [
        {
          type: 3,
          name: 'position',
          description: 'Position, e.g. NZCH_APP',
          required: true
        },
        {
          type: 3,
          name: 'date',
          description: 'NZ date in DD/MM format',
          required: true
        },
        {
          type: 3,
          name: 'start',
          description: 'Start time in HHMM format',
          required: true
        },
        {
          type: 3,
          name: 'end',
          description: 'End time in HHMM format',
          required: true
        }
      ]
    },
    {
      name: 'openeventposition',
      description: 'Open event positions.',
      options: [
        {
          type: 3,
          name: 'position',
          description: 'What position do you want to open?',
          required: true,
          choices: [
            { name: 'nzzo-e_fss', value: 'NZZO-E_FSS' },
            { name: 'nzaa-r_ctr', value: 'NZAA-R_CTR' },
            { name: 'nzch-d_ctr', value: 'NZCH-D_CTR' },
            { name: 'nzaa_dep', value: 'NZAA_DEP' },
            { name: 'nzch_dep', value: 'NZCH_DEP' },
            { name: 'nzwn_dep', value: 'NZWN_DEP' },
            { name: 'nstu_twr', value: 'NSTU_TWR' },
            { name: 'nzmf_twr', value: 'NZMF_TWR' },
            { name: 'nzpp_twr', value: 'NZPP_TWR' },
            { name: 'nzfx_gnd', value: 'NZFX_GND' },
            { name: 'nzqn_gnd', value: 'NZQN_GND' },
            { name: 'ncrg_del', value: 'NCRG_DEL' },
            { name: 'nzfx_del', value: 'NZFX_DEL' }
          ]
        },
        {
          type: 3,
          name: 'date',
          description: 'What date do you want to open? Format: DD/MM',
          required: true
        }
      ]
    },
    {
      name: 'closeeventposition',
      description: 'Close event positions.',
      options: [
        {
          type: 3,
          name: 'position',
          description: 'What position do you want to close?',
          required: true,
          choices: [
            { name: 'nzzo-e_fss', value: 'NZZO-E_FSS' },
            { name: 'nzaa-r_ctr', value: 'NZAA-R_CTR' },
            { name: 'nzch-d_ctr', value: 'NZCH-D_CTR' },
            { name: 'nzaa_dep', value: 'NZAA_DEP' },
            { name: 'nzch_dep', value: 'NZCH_DEP' },
            { name: 'nzwn_dep', value: 'NZWN_DEP' },
            { name: 'nstu_twr', value: 'NSTU_TWR' },
            { name: 'nzmf_twr', value: 'NZMF_TWR' },
            { name: 'nzpp_twr', value: 'NZPP_TWR' },
            { name: 'nzfx_gnd', value: 'NZFX_GND' },
            { name: 'nzqn_gnd', value: 'NZQN_GND' },
            { name: 'ncrg_del', value: 'NCRG_DEL' },
            { name: 'nzfx_del', value: 'NZFX_DEL' }
          ]
        }
      ]
    },
    {
      name: 'mentor',
      description: 'Tag your mentor in your post',
      options: [
        {
          type: 6,
          name: 'mentor',
          description: 'Tag your mentor. Format: @mymentor',
          required: true
        }
      ]
    }
  ], {
    debug: false
  });

  async function handleViewBookings(interaction) {
    const { EmbedBuilder } = require('discord.js');

    const userId = String(interaction.member.user.id);
    const userBookings = messages.get(userId);

    if (!Array.isArray(userBookings) || userBookings.length === 0) {
      await interaction.reply({
        content: '📭 You have no current bookings.',
        ephemeral: true
      });
      return;
    }

    const sorted = userBookings.sort((a, b) => {
      const [dayA, monthA] = a.date.split('/').map(Number);
      const [dayB, monthB] = b.date.split('/').map(Number);
      const currentYear = new Date().getFullYear();
      const startA = String(a.start).padStart(4, '0');
      const startB = String(b.start).padStart(4, '0');
      const hourA = parseInt(startA.slice(0, 2), 10);
      const minuteA = parseInt(startA.slice(2), 10);
      const hourB = parseInt(startB.slice(0, 2), 10);
      const minuteB = parseInt(startB.slice(2), 10);
      const dateA = new Date(currentYear, monthA - 1, dayA, hourA, minuteA);
      const dateB = new Date(currentYear, monthB - 1, dayB, hourB, minuteB);
      return dateA - dateB;
    });

    const embed = new EmbedBuilder()
      .setTitle('📋 Your Bookings')
      .setColor('#00AEFF')
      .setDescription(
        sorted.map(b =>
          `• **${b.position}** on **${b.date}** from **${b.start}** to **${b.end}**`
        ).join('\n')
      )
      .setFooter({ text: 'Use /deletebookings to remove a booking.' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  };
  
  async function handleOpenEventPosition(interaction) {
    const position = interaction.options.getString('position');
    const date = interaction.options.getString('date');

    if (!/^\d{2}\/\d{2}$/.test(date)) {
      await interaction.reply({
        content: 'Date must be in the format DD/MM (e.g., 06/25). Please correct it.',
        ephemeral: true
      });
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
      await interaction.reply({ content: 'Booking channel not found.', ephemeral: true });
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

    await interaction.reply({
      content: `${position} opened!`,
      ephemeral: true
    });
  };

  async function handleExtendSectorSelect(interaction) {
    try {
      const Discord = require("discord.js");

      const sectorCodeMap = {
        "NZAA_CTR": "OCR",
        "NZCH-B_CTR": "BAY",
        "NZOH_CTR": "OHA",
        "NZCH-K_CTR": "KAI",
        "NZCH-T_CTR": "NAK",
        "NZCH-S_CTR": "STH"
      };

      const selections = interaction.values;

      const userId = String(interaction.member.user.id);
      const userBookings = messages.get(userId);
      if (!Array.isArray(userBookings)) {
        return;
      }

      const [messageId] = selections[0].split('|');
      const booking = userBookings.find(b => b.messageId === messageId || (Array.isArray(b.previousMessageIds) && b.previousMessageIds.includes(messageId)));
      if (!booking) {
        return;
      }

      if (selections.includes(`${messageId}|NO_EXTENSION`)) {
        clearExtensionSelectionTimer(messageId);
        booking.awaitingExtensionSelection = false;
        messages.set(userId, userBookings);

        if (interaction.replied || interaction.deferred) {
          await interaction.editReply({ content: '✅ No additional sectors selected.', components: [] });
        } else {
          await interaction.reply({ content: '✅ No additional sectors selected.', components: [], ephemeral: true });
        }

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
        } else {
        }
      }

      if (updated) {
        const msg = await fetchBookingMessage(booking);
        if (!msg) throw new Error('Booking message not found');
        const embed = msg.embeds[0];
        const newEmbed = new Discord.EmbedBuilder()
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

 if (interaction.replied || interaction.deferred) {
  await interaction.editReply({ content: '✅ Extended sectors updated.', components: [] });
} else {
  await interaction.reply({ content: '✅ Extended sectors updated.', components: [], ephemeral: true });
}

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
      console.error('❌ Error in extend_sector_select handler:', err);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: '❌ Something went wrong.', components: [] });
        } else {
          await interaction.reply({ content: '❌ Something went wrong.', components: [], ephemeral: true });
        }
      } catch (e) {
        console.warn('⚠️ Failed to send error reply:', e);
      }
    }
  };

  async function handleCloseEventPosition(interaction) {
    event.set(String((interaction.options.getString('position'))), '0/0');
    const bookingChannel = await getBookingChannel();
    const closeMessageId = eventclose.get(String((interaction.options.getString('position'))));
    if (bookingChannel?.messages && closeMessageId) {
      try {
        const s4dmessage = await bookingChannel.messages.fetch(closeMessageId);
        await s4dmessage.delete();
      } catch (err) {
        console.warn(`Could not delete event close message ${closeMessageId}:`, err?.message || err);
      }
    }
    await interaction.reply({ content: (String(interaction.options.getString('position')) + ' closed!'), ephemeral: true, components: [] });
    await sendAuditLog({
      action: 'Event Position Closed',
      actorId: interaction.user.id,
      fields: [
        { name: 'Position', value: String(interaction.options.getString('position')), inline: true }
      ],
      color: '#D9534F'
    });

  };  async function handleMentorBookingSelect(interaction) {
    const [selectedIndex, mentorId] = interaction.values[0].split('|');
    const userId = String(interaction.member.user.id);
    const userBookings = messages.get(userId);

    if (!Array.isArray(userBookings) || !userBookings[selectedIndex]) {
      await interaction.update({
        content: '❌ Booking not found.',
        components: [],
        ephemeral: true
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
      console.error('❌ Failed to fetch/update booking message:', err);
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

    const tagTimer = mentorTagTimeouts.get(booking.messageId);
    if (tagTimer) {
      clearTimeout(tagTimer);
      mentorTagTimeouts.delete(booking.messageId);
    }
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
            ? `${interaction.user.username} has booked **${booking.position}** on **${booking.date}** at **${booking.start}** and tagged you. Please react with ${THUMBS_UP} on the booking message above within 30 minutes.`
            : `${interaction.user.username} has booked **${booking.position}** on **${booking.date}** at **${booking.start}** and tagged you.`
        }]
      });
    } catch (err) {
      console.error('❌ Failed to DM mentor:', err);
    }

    await interaction.update({
      content: booking.mentorRequired
        ? `✅ Booking for ${booking.position} on ${booking.date} at ${booking.start} has been sent to your mentor. They have 30 minutes to approve with ${THUMBS_UP}.`
        : `✅ Booking for ${booking.position} on ${booking.date} at ${booking.start} has been sent to your mentor.`,
      components: [],
      ephemeral: true
    });
  };


  async function handleMentor(interaction) {
      const userId = String(interaction.member.user.id);
      const mentor = interaction.options.getMember('mentor');
      const userBookings = messages.get(userId);

      if (!Array.isArray(userBookings) || userBookings.length === 0) {
        await interaction.reply({
          content: '📭 You have no bookings to tag a mentor for.',
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
        content: `👨‍🏫 Select the booking you want to notify **${mentor.user.username}** about:`,
        components: [row],
        ephemeral: true
      });

  };

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

  return s4d
})();
