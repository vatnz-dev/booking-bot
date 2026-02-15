(async () => {
  require('dotenv').config();

  const Database = require("easy-json-database")
  const event = new Database('./event.json')
  const messages = new Database("./messages.json");
  const eventclose = new Database('./eventclose.json')
  const cheerio = require('cheerio');
  const { DateTime } = require('luxon');
  const axios = require('axios');
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
    ButtonStyle
  } = require("discord.js");
  const fs = require('fs');
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const trafficCache = new Map();
  const syncCommands = require('discord-sync-commands');
  const mentorTagTimeouts = new Map();
  const mentorApprovalTimeouts = new Map();
  const extensionSelectionTimeouts = new Map();

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

  client.once('ready', () => {
    console.log(`${client.user.tag} is alive!`);
  });

  client.login(process.env.DISCORD_TOKEN);

  client.on('clientReady', async () => {
    client.user.setPresence({ status: "online", activities: [{ name: 'ATC Bookings', type: ActivityType.Watching }] });
  });

  async function handleDeleteBookings(interaction) {
    const { ActionRowBuilder, SelectMenuBuilder } = require('discord.js');

    const userId = String(interaction.member.user.id);
    const userBookings = messages.get(userId);

    if (!Array.isArray(userBookings) || userBookings.length === 0) {
      await interaction.reply({
        content: '📭 You have no current bookings.',
        ephemeral: true
      });
      return;
    }

    const options = userBookings.map((b, index) => ({
      label: `${b.position} on ${b.date} at ${b.start}`,
      description: `Ends at ${b.end}`,
      value: String(index)
    }));

    const row = new ActionRowBuilder().addComponents(
      new SelectMenuBuilder()
        .setCustomId('delete_booking_select')
        .setPlaceholder('Select a booking to delete')
        .addOptions(options)
    );

    await interaction.reply({
      content: '🗑️ Select a booking to delete:',
      components: [row],
      ephemeral: true
    });
  }

  client.on('interactionCreate', async (interaction) => {

  // Slash commands
  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {
      case 'closeeventposition':
        await handleCloseEventPosition(interaction);
        break;
      case 'deletebookings':
        await handleDeleteBookings(interaction);
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

  async function removeBookingAndNotify({ ownerId, messageId, dmText }) {
    const entry = findBookingByMessageId(messageId);
    if (!entry) return;

    entry.bookings.splice(entry.index, 1);
    messages.set(entry.ownerId, entry.bookings);
    clearMentorTimers(messageId);

    try {
      const channel = client.channels.cache.get(process.env.CHANNEL_ID);
      const msg = await channel.messages.fetch(messageId);
      await msg.delete();
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
  }

  function scheduleMentorTagTimeout(ownerId, messageId) {
    clearMentorTimers(messageId);
    const timeout = setTimeout(async () => {
      const entry = findBookingByMessageId(messageId);
      if (!entry || !entry.booking.mentorRequired) return;
      if (entry.booking.mentorId) return;
      await removeBookingAndNotify({
        ownerId,
        messageId,
        dmText: 'Your booking was auto-deleted because you did not tag a mentor within 5 minutes. Please rebook and tag your mentor promptly.'
      });
    }, 5 * 60 * 1000);
    mentorTagTimeouts.set(messageId, timeout);
  }

  function scheduleMentorApprovalTimeout(ownerId, messageId) {
    const existing = mentorApprovalTimeouts.get(messageId);
    if (existing) clearTimeout(existing);

    const timeout = setTimeout(async () => {
      const entry = findBookingByMessageId(messageId);
      if (!entry || !entry.booking.mentorRequired) return;
      if (entry.booking.mentorApproved) return;
      await removeBookingAndNotify({
        ownerId,
        messageId,
        dmText: `Your booking was auto-deleted because your mentor did not approve with a ${THUMBS_UP} within 30 minutes. Please rebook and get your mentor to approve.`
      });
    }, 30 * 60 * 1000);
    mentorApprovalTimeouts.set(messageId, timeout);
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

      const channel = client.channels.cache.get(process.env.CHANNEL_ID);
      const msg = await channel.messages.fetch(messageId);
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
    const selectedIndex = parseInt(interaction.values[0]);
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
    messages.set(userId, userBookings);


    try {
      const channel = interaction.channel;
      const messageToDelete = await channel.messages.fetch(booking.messageId);
      await messageToDelete.delete();
    } catch (err) {
      console.error(`⚠️ Could not delete message ${booking.messageId}:`, err);
    }

    await interaction.update({
      content: `✅ Booking for ${booking.position} on ${booking.date} at ${booking.start} has been deleted.`,
      components: [],
      ephemeral: true
    });
  };

  client.on('ready', async () => {
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
    plan.setCustomId('plan'); plan.setStyle(ButtonStyle.Secondary); plan.setLabel('Book Controlling Session'); client.channels.cache.get(process.env.CHANNEL_ID).send({
      content: String(' '),
      components: [new ActionRowBuilder().addComponents(plan)],
      embeds: [plan_embed]
    });

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
              const channel = client.channels.cache.get(process.env.CHANNEL_ID);
              const msg = await channel.messages.fetch(b.messageId);
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

      if (eventName) {
        bookingEmbed.addFields({ name: 'Event', value: eventName, inline: false });
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

      const channel = client.channels.cache.get(process.env.CHANNEL_ID);
      const sentMessage = await channel.send({ embeds: [bookingEmbed] });

      const existing = messages.get(userId);
      const userBookings = Array.isArray(existing) ? existing : (existing ? [existing] : []);
      userBookings.push({
        position: pos,
        date,
        start,
        end,
        messageId: sentMessage.id,
        extendedSectors,
        awaitingExtensionSelection: false,
        mentorRequired,
        mentorId: null,
        mentorApproved: false,
        createdAt: new Date().toISOString(),
        // bookingvatid
      });
      messages.set(userId, userBookings);

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
    const { ActionRowBuilder, SelectMenuBuilder } = require('discord.js');
    const row = new ActionRowBuilder().addComponents(
      new SelectMenuBuilder()
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
      description: 'Delete your controller bookings.'
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

    const channel = client.channels.cache.get(process.env.CHANNEL_ID);
    const sentMessage = await channel.send({ embeds: [embed] });

    eventclose.set(position, sentMessage.id);

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
      const booking = userBookings.find(b => b.messageId === messageId);
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
        const channel = client.channels.cache.get(process.env.CHANNEL_ID);
        const msg = await channel.messages.fetch(messageId);
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
    client.channels.cache.get(process.env.CHANNEL_ID).messages.fetch(eventclose.get(String((interaction.options.getString('position'))))).then(async (s4dmessage) => {
      (s4dmessage).delete()
      await interaction.reply({ content: (String(interaction.options.getString('position')) + ' closed!'), ephemeral: true, components: [] });

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
      const channel = client.channels.cache.get(process.env.CHANNEL_ID);
      const s4dmessage = await channel.messages.fetch(booking.messageId);
      await s4dmessage.react(THUMBS_UP);

      const guildId = client.guilds.cache.get('1424636974312198187').id;
      messageLink = `https://discord.com/channels/${guildId}/${channel.id}/${booking.messageId}`;

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

    const tagTimer = mentorTagTimeouts.get(booking.messageId);
    if (tagTimer) {
      clearTimeout(tagTimer);
      mentorTagTimeouts.delete(booking.messageId);
    }
    if (booking.mentorRequired) {
      scheduleMentorApprovalTimeout(userId, booking.messageId);
    }

    try {
      const guild = client.guilds.cache.get('1424636974312198187');
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
      const { ActionRowBuilder, SelectMenuBuilder } = require('discord.js');

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
        new SelectMenuBuilder()
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
  return s4d
})();
