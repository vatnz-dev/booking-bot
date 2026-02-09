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

function getPreviousWeekNZ(dateStr) {
  const [day, month] = dateStr.split('/').map(Number);
  const year = DateTime.now().setZone('Pacific/Auckland').year;
  const nzDate = DateTime.fromObject({ year, month, day }, { zone: 'Pacific/Auckland' });
  return nzDate.minus({ weeks: 1 }).toFormat('yyyy-MM-dd');
}

async function getTrafficData(icao, date) {
  const key = `${icao}_${date}`;
  if (trafficCache.has(key)) return trafficCache.get(key);

  const url = `https://statsim.net/events/custom/?airports=${icao}&period=custom&from=${date}+00:00&to=${date}+23:00`;
  const { data: html } = await axios.get(url);
  const $ = cheerio.load(html);
  const text = $('body').text();

  const arrivals = parseInt(text.match(/Arrivals:\s*(\d+)/)?.[1] || 0);
  const departures = parseInt(text.match(/Departures:\s*(\d+)/)?.[1] || 0);
  const result = { icao, arrivals, departures };

  trafficCache.set(key, result);
  return result;
}

async function getSectorTraffic(sector, date) {
  const aerodromes = sectorAerodromeMap[sector] || [];

  const promises = aerodromes.map(icao =>
    getTrafficData(icao, date).catch(() => ({ arrivals: 0, departures: 0 }))
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

async function formatAerodromeTraffic(position, date) {
  const aerodromes = resolveAerodromes(position);

  const promises = aerodromes.map(icao =>
    getTrafficData(icao, date).catch(() => ({ icao, arrivals: 0, departures: 0 }))
  );

  const results = await Promise.all(promises);

  let out = `📊 **Expected Traffic (based on ${date})**\n`;

  for (const r of results) {
    out += `• **${r.icao}** — ${r.arrivals} arrivals / ${r.departures} departures\n`;
  }

  return out;
}

async function formatSectorTraffic(sectors, date) {
  let out = `📊 **Expected Traffic (based on ${date})**\n`;
  for (const sector of sectors) {
    const t = await getSectorTraffic(sector, date);
    out += `• **${t.sectorCode}** — ${t.total} movements (${t.arrivals} arrivals / ${t.departures} departures)\n`;
  }
  return out;
}

  const { Client, GatewayIntentBits, Partials } = require('discord.js');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessages
    ],
    partials: [Partials.Channel, Partials.Message]
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
        // bookingvatid
      });
      messages.set(userId, userBookings);

      const prevDate = getPreviousWeekNZ(date);

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
      content: '✅ Booking Created. No additional sectors available for extension.',
      ephemeral: true
    });

    const traffic = await formatSectorTraffic([pos], prevDate);
    await i.followUp({ content: traffic, ephemeral: true });
  } else {
    const options = availableSectors.map(sector => ({
      label: sector,
      value: `${sentMessage.id}|${sector}`
    }));
    const { ActionRowBuilder, SelectMenuBuilder } = require('discord.js');
    const row = new ActionRowBuilder().addComponents(
      new SelectMenuBuilder()
        .setCustomId('extend_sector_select')
        .setPlaceholder('Select sectors to extend into')
        .setMinValues(0)
        .setMaxValues(options.length)
        .addOptions(options)
    );

    await i.editReply({
      content: '✅ Booking Created. Select sectors you want to extend into:',
      components: [row],
      ephemeral: true
    });
  }
} else {
  await i.editReply({
    content: '✅ Booking Created. To delete, run /deletebookings with the same position and date.',
    ephemeral: true
  });

  const traffic = await formatAerodromeTraffic(pos, prevDate);
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
      .setFooter({ text: 'Use /deletebooking to remove a booking.' });

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

 if (interaction.replied || interaction.deferred) {
  await interaction.editReply({ content: '✅ Extended sectors updated.', components: [] });
} else {
  await interaction.reply({ content: '✅ Extended sectors updated.', components: [], ephemeral: true });
}

const prevDate = getPreviousWeekNZ(booking.date);
const allSectors = [booking.position, ...booking.extendedSectors];
const traffic = await formatSectorTraffic(allSectors, prevDate);

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

  };

  async function handleMentorBookingSelect(interaction) {
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
      await s4dmessage.react('👍');

      const guildId = client.guilds.cache.get('1424636974312198187').id;
      messageLink = `https://discord.com/channels/${guildId}/${channel.id}/${booking.messageId}`;
    } catch (err) {
      console.error('❌ Failed to react or fetch message:', err);
    }

    try {
      const guild = client.guilds.cache.get('1424636974312198187');
      const mentorMember = guild.members.cache.get(mentorId) || await guild.members.fetch(mentorId);

      await mentorMember.send({
        content: messageLink,
        embeds: [{
          color: 0x000000,
          title: 'Your student has booked a session',
          description: `${interaction.user.username} has booked **${booking.position}** on **${booking.date}** at **${booking.start}** and tagged you. Please react with 👍 on the booking message above.`
        }]
      });
    } catch (err) {
      console.error('❌ Failed to DM mentor:', err);
    }

    await interaction.update({
      content: `✅ Booking for ${booking.position} on ${booking.date} at ${booking.start} has been sent to your mentor.`,
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
