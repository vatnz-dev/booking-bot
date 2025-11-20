(async()=>{
    const events = require('events');
    const { exec } = require("child_process")
    const logs = require("discord-logs")
    const Discord = require("discord.js")
    const { 
        MessageEmbed, 
        MessageButton, 
        MessageActionRow, 
        Intents, 
        Permissions, 
        MessageSelectMenu 
    }= require("discord.js")
    const fs = require('fs');
    let process = require('process');
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const os = require("os-utils");
    let URL = require('url')
    const ms = require("ms")
    let https = require("https")
    const synchronizeSlashCommands = require('@frostzzone/discord-sync-commands');
    const Database  = require("easy-json-database")
    
    let s4d = {
        Discord,
        fire:null,
        joiningMember:null,
        reply:null,
        player:null,
        manager:null,
        Inviter:null,
        message:null,
        notifer:null,
        checkMessageExists() {
            if (!s4d.client) throw new Error('You cannot perform message operations without a Discord.js client')
            if (!s4d.client.readyTimestamp) throw new Error('You cannot perform message operations while the bot is not connected to the Discord API')
        }
    };

    if (!require('./package.json').dependencies['discord.js'].startsWith("^13.")) {
      let file = JSON.parse(fs.readFileSync('package.json'))
      file.dependencies['discord.js'] = '^13.16.0'
      fs.writeFileSync('package.json', JSON.stringify(file, null, 4))
      exec('npm i')
      throw new Error("Seems you arent using v13 please re-run or run `npm i discord.js@13.16.0`");
    }

    if (!require('./package.json').dependencies['discord-logs'].startsWith("^2.")) {
      let file = JSON.parse(fs.readFileSync('package.json'))
      file.dependencies['discord-logs'] = '^2.0.0'
      fs.writeFileSync('package.json', JSON.stringify(file, null, 4))
      exec('npm i')
      throw new Error("discord-logs must be 2.0.0. please re-run or if that fails run `npm i discord-logs@2.0.0` then re-run");
    }

    s4d.client = new s4d.Discord.Client({
        intents: [
            Object.values(s4d.Discord.Intents.FLAGS).reduce((acc, p) => acc | p, 0)
        ],
        partials: [
            "REACTION", 
            "CHANNEL"
        ]
    });

    s4d.client.on('ready', () => {
        console.log(s4d.client.user.tag + " is alive!")
    })

    process.on('uncaughtException', function (err) {
        console.log('Error!');
        console.log(err);
    });

    logs(s4d.client);

    const discordModals = require('discord-modals');
    discordModals(s4d.client);
    const { Modal, TextInputComponent, showModal } = require('discord-modals');

    s4d.client.on('interactionCreate', async (interaction) => {
              if ((interaction.commandName) == 'edit') {
      }
    
        });
    
    s4d.client.on('ready', async () => {
      s4d.client.user.setPresence({status: "online",activities:[{name:'ATC Bookings',type:"WATCHING"}]});
    
    });
    
    await s4d.client.login('MTQyNDYzODQ0Mjc1ODg2OTAyNA.Ghj-X1.kweWSAeksN8MLBkFJGcAYII2GMWe3xqF5L0a90').catch((e) => {
            const tokenInvalid = true;
            const tokenError = e;
            if (e.toString().toLowerCase().includes("token")) {
                throw new Error("An invalid bot token was provided!")
            } else {
                throw new Error("Privileged Gateway Intents are not enabled! Please go to https://discord.com/developers and turn on all of them.")
            }
        });
    
    s4d.client.on('interactionCreate', async (interaction) => {
              if ((interaction.commandName) == 'deletebookings') {
        const { MessageActionRow, MessageSelectMenu } = require('discord.js');
        const Database = require("easy-json-database");
        const messages = new Database("./messages.json");
    
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
    
        const row = new MessageActionRow().addComponents(
          new MessageSelectMenu()
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
    
        });
    // Convert DD/MM and HHMM to UTC string "YYYY-MM-DD HH:mm:ss"
function convertToUTC(dateStr, timeStr) {
  const [day, month] = dateStr.split('/');
  const year = new Date().getFullYear();

  // Parse time string like "1900" or "0210"
  const hours = parseInt(timeStr.slice(0, 2), 10);
  const minutes = parseInt(timeStr.slice(2), 10);

  // Create NZ local time
  const nzDate = new Date(Date.UTC(year, month - 1, day, hours, minutes));
  // Adjust for NZDT offset (+13). Use +12 if NZST.
  nzDate.setHours(nzDate.getHours() - 13);

  return nzDate.toISOString().replace('T', ' ').slice(0, 19);
}

// Get VATSIM ID from Discord ID
async function getVatsimId(discordId) {
  try {
    const response = await axios.get(`https://api.vatsim.net/v2/members/discord/${discordId}`);
    return response.data.user_id;
  } catch (error) {
    console.error('Failed to fetch VATSIM ID:', error.response?.status);
    return null;
  }
}

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

   s4d.client.on('interactionCreate', async (interaction) => {
  if (!interaction.isSelectMenu()) return;
  if (interaction.customId !== 'delete_booking_select') return;

  const Database = require("easy-json-database");
  const messages = new Database("./messages.json");

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

  // --- Delete booking from VATSIM API if bookingvatid exists ---
  if (booking.bookingvatid) {
    try {
      await axios.delete(`https://atc-bookings.vatsim.net/api/booking/${booking.bookingvatid}`);
      console.log(`✅ VATSIM booking ${booking.bookingvatid} deleted.`);
    } catch (error) {
      console.error(`⚠️ Failed to delete VATSIM booking ${booking.bookingvatid}:`, error.response?.status);
    }
  }

  // --- Remove booking locally ---
  userBookings.splice(selectedIndex, 1);
  messages.set(userId, userBookings);

  // --- Delete the Discord message if it exists ---
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
  });
    
    
    s4d.client.on('ready', async () => {
      event.set(String('NZZO-E_FSS'), '0/0');
      event.set(String('NZAA-R_CTR'), '0/0');
      event.set(String('NZCH-D_CTR'), '0/0');
      event.set(String('NZAA_DEP'), '0/0');
      event.set(String('NZCH_DEP'), '0/0');
      event.set(String('NZWN_DEP'), '0/0');
      event.set(String('NSTU_TWR'), '0/0');
      event.set(String('NZMF_TWR'), '0/0');
      event.set(String('NZPP_TWR'), '0/0');
      event.set(String('NZFX_GND'), '0/0');
      event.set(String('NZQN_GND'), '0/0');
      event.set(String('NCRG_DEL'), '0/0');
      event.set(String('NZFX_DEL'), '0/0');
      var plan_embed = new Discord.MessageEmbed();
         plan_embed.setColor('#000000');
        plan_embed.setTitle(String('Book A Controlling Session'))
         plan_embed.setURL(String());
        plan_embed.setDescription(String('Controllers may post in this channel indicating that they intend to log onto a specific callsign at a specific time. This channel does not act as a booking system, but merely a heads-up that you intend to log on around that time.'));
        plan_embed.addField(String('Under mentoring?'), String('You must run the /mentor command and put your Mentor/Instructor\'s first and last name in your post. If you are logging on and utilising your Solo Endorsement, you must also state this in your controller info.'), true);
        plan_embed.addField(String('More Infomation?'), String('https://www.vatnz.net/vatnz/policies/atc-policy/'), false);
    
      let plan = new MessageButton()
        plan.setCustomId('plan');plan.setStyle("SECONDARY");plan.setLabel('Book Controlling Session');s4d.client.channels.cache.get('1424637009686696040').send({
              content: String(' '),
              components: [new MessageActionRow().addComponents(plan)],
              embeds: [plan_embed]
              });
    });
    
    s4d.client.on('interactionCreate', async (i) => {
            let member = i.guild.members.cache.get(i.member.user.id)
            let interaction = i; if (!(i.isButton())) return;
              if (((i.customId)) == 'plan') {
        let plan = new Modal()
            .setCustomId('plan')
            .setTitle('Book Controlling Session')
            .addComponents(
          new TextInputComponent()
              .setCustomId('pos')
              .setLabel('What Position? Format: NZAA_CTR')
              .setStyle(('SHORT'))
              .setMinLength(8)
              .setMaxLength(12)
              .setRequired(true),
          new TextInputComponent()
              .setCustomId('date')
              .setLabel('What Date? Format: 25/06')
              .setStyle(('SHORT'))
              .setMinLength(5)
              .setMaxLength(5)
              .setRequired(true),
          new TextInputComponent()
              .setCustomId('start')
              .setLabel('What Time Do You Plan To Start ? Format: 1800')
              .setStyle(('SHORT'))
              .setMinLength(4)
              .setMaxLength(4)
              .setRequired(true),
          new TextInputComponent()
              .setCustomId('end')
              .setLabel('What Time Do You Plan To End ? Format: 1900')
              .setStyle(('SHORT'))
              .setMinLength(4)
              .setMaxLength(4)
              .setRequired(true),
          new TextInputComponent()
              .setCustomId('event')
              .setLabel('Is This A Event? Format: Christchurch Control')
              .setStyle(('SHORT'))
              .setMinLength(0)
              .setMaxLength(45)
              .setRequired(false),
        );showModal(plan, {
                client: s4d.client,
                interaction: interaction
            })}
    
        });
    
    const event = new Database('./event.json')
    synchronizeSlashCommands(s4d.client, [
      {
          name: 'editbookings',
      		description: 'Edit your controller bookings.',
      		options: [
    
          ]
      },{
          name: 'viewbookings',
      		description: 'View your controller bookings.',
      		options: [
    
          ]
      },{
          name: 'deletebookings',
      		description: 'Delete your controller bookings.',
      		options: [
    
          ]
      },{
          name: 'openeventposition',
      		description: 'Open event positions.',
      		options: [
              {
            type: 3,
        	name: 'position',
            required: true,
        	description: 'What position do you want to open?',
            choices: [
                  {
              name: String('nzzo-e_fss'),
              value: String('NZZO-E_FSS')
          },{
              name: String('nzaa-r_ctr'),
              value: String('NZAA-R_CTR')
          },{
              name: String('nzch-d_ctr'),
              value: String('NZCH-D_CTR')
          },{
              name: String('nzaa_dep'),
              value: String('NZAA_DEP')
          },{
              name: String('nzch_dep'),
              value: String('NZCH_DEP')
          },{
              name: String('nzwn_dep'),
              value: String('NZWN_DEP')
          },{
              name: String('nstu_twr'),
              value: String('NSTU_TWR')
          },{
              name: String('nzmf_twr'),
              value: String('NZMF_TWR')
          },{
              name: String('nzpp_twr'),
              value: String('NZPP_TWR')
          },{
              name: String('nzfx_gnd'),
              value: String('NZFX_GND')
          },{
              name: String('nzqn_gnd'),
              value: String('NZQN_GND')
          },{
              name: String('ncrg_del'),
              value: String('NCRG_DEL')
          },{
              name: String('nzfx_del'),
              value: String('NZFX_DEL')
          },
            ]
        },{
            type: 3,
        	name: 'date',
            required: true,
        	description: 'What date do you want to open? Format: DD/MM',
            choices: [
    
            ]
        },
          ]
      },{
          name: 'closeeventposition',
      		description: 'Close event positions.',
      		options: [
              {
            type: 3,
        	name: 'position',
            required: true,
        	description: 'What position do you want to close?',
            choices: [
                  {
              name: String('nzzo-e_fss'),
              value: String('NZZO-E_FSS')
          },{
              name: String('nzaa-r_ctr'),
              value: String('NZAA-R_CTR')
          },{
              name: String('nzch-d_ctr'),
              value: String('NZCH-D_CTR')
          },{
              name: String('nzaa_dep'),
              value: String('NZAA_DEP')
          },{
              name: String('nzch_dep'),
              value: String('NZCH_DEP')
          },{
              name: String('nzwn_dep'),
              value: String('NZWN_DEP')
          },{
              name: String('nstu_twr'),
              value: String('NSTU_TWR')
          },{
              name: String('nzmf_twr'),
              value: String('NZMF_TWR')
          },{
              name: String('nzpp_twr'),
              value: String('NZPP_TWR')
          },{
              name: String('nzfx_gnd'),
              value: String('NZFX_GND')
          },{
              name: String('nzqn_gnd'),
              value: String('NZQN_GND')
          },{
              name: String('ncrg_del'),
              value: String('NCRG_DEL')
          },{
              name: String('nzfx_del'),
              value: String('NZFX_DEL')
          },
            ]
        },
          ]
      },{
          name: 'mentor',
      		description: 'Tag your mentor in your post',
      		options: [
              {
            type: 6,
        	name: 'mentor',
            required: true,
        	description: 'Tag your mentor. Format: @mymentor',
            choices: [
    
            ]
        },
          ]
      },
    ],{
        debug: false,
    
    });
    
    s4d.client.on('interactionCreate', async (interaction) => {
              if ((interaction.commandName) == 'viewbookings') {
        const Database = require("easy-json-database");
        const messages = new Database("./messages.json");
        const { MessageEmbed } = require('discord.js');
    
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
          const dateA = new Date(2025, monthA - 1, dayA, a.start);
          const dateB = new Date(2025, monthB - 1, dayB, b.start);
          return dateA - dateB;
        });
    
        const embed = new MessageEmbed()
          .setTitle('📋 Your Bookings')
          .setColor('#00AEFF')
          .setDescription(
            sorted.map(b =>
              `• **${b.position}** on **${b.date}** from **${b.start}** to **${b.end}**`
            ).join('\n')
          )
          .setFooter('Use /deletebooking to remove a booking.');
    
        await interaction.reply({ embeds: [embed], ephemeral: true });
    
      }
    
        });
    
    s4d.client.on('modalSubmit', async (i) => {
      if (i.customId !== 'plan') return;
    
      const { MessageEmbed, MessageActionRow, MessageSelectMenu } = require('discord.js');
      const Database = require('easy-json-database');
      const messages = new Database('./messages.json');
      const eventDB = new Database('./event.json');
    
      const member = i.member;
      const userId = member.user.id;
    
      const posRaw = i.getTextInputValue('pos');
      const pos = posRaw.trim().toUpperCase();
      const date = i.getTextInputValue('date').trim();
      const start = parseInt(i.getTextInputValue('start').trim());
      const end = parseInt(i.getTextInputValue('end').trim());
      const eventName = i.getTextInputValue('event');
    
      const autoInheritanceMap = {
        "NZAA_CTR": ["NZCH-B_CTR"],
        "NZCH-T_CTR": ["NZOH_CTR"],
        "NZCH-S_CTR": ["NZCH-K_CTR"]
      };
    
      const sectorCodeMap = {
        "NZAA_CTR": "OCR",
        "NZCH-B_CTR": "BAY",
        "NZOH_CTR": "OHA",
        "NZCH-K_CTR": "KAI",
        "NZCH-T_CTR": "NAK",
        "NZCH-S_CTR": "STH"
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
    
      if (posRaw !== pos) return i.reply({ content: '❌ Position must be in ALL CAPS.', ephemeral: true });
      if (isNaN(start) || isNaN(end)) return i.reply({ content: '❌ Start and End times must be valid numbers.', ephemeral: true });
    
      const eventKeys = Object.keys(eventDB.all()).reduce((acc, key) => {
        acc[key.toUpperCase()] = eventDB.get(key);
        return acc;
      }, {});
      const unlockedDate = eventKeys[pos];
      if (unlockedDate && unlockedDate !== date) {
        return i.reply({ content: `❌ This position is locked. It is only unlocked for ${unlockedDate}.`, ephemeral: true });
      }
    
      if (fssPositions.includes(pos) && !member._roles.includes(fssRoleId)) {
        return i.reply({ content: '❌ You do not have the Oceanic Endorsement required to book this FSS position.', ephemeral: true });
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
            return i.reply({ content: '❌ This time slot is already booked for that position.', ephemeral: true });
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
              const channel = s4d.client.channels.cache.get('1424637009686696040');
              const msg = await channel.messages.fetch(b.messageId);
              const embed = msg.embeds[0];
              const newEmbed = new MessageEmbed()
                .setColor(embed.color)
                .setTitle(embed.title)
                .setTimestamp(embed.timestamp)
                .setThumbnail(embed.thumbnail?.url)
                .setFooter(embed.footer?.text ? { text: embed.footer.text } : null);
    
              for (const field of embed.fields) {
                if (field.name !== 'Extended Sectors') {
                  newEmbed.addField(field.name, field.value, field.inline);
                }
              }
    
              if (b.extendedSectors.length > 0) {
                const display = b.extendedSectors.map(s => sectorCodeMap[s] || s);
                newEmbed.addField('Extended Sectors', display.join(', '), false);
              }
    
              await msg.edit({ embeds: [newEmbed] });
            } catch (err) {
              console.warn(`⚠️ Could not update embed for booking ${b.messageId}`);
            }
    
            try {
              const user = await s4d.client.users.fetch(otherUserId);
              const reason = otherUserId === userId
                ? 'You booked a new session that overrides these sectors.'
                : 'Another controller booked or inherited these sectors.';
    
              await user.send({
                content: `📭 One or more extended sectors were removed from your booking.`,
                embeds: [
                  new MessageEmbed()
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
    const axios = require('axios');
// --- Prepare UTC times ---
const startUTC = convertToUTC(date, String(start).padStart(4, '0'));
const endUTC = convertToUTC(date, String(end).padStart(4, '0'));

// --- Get VATSIM ID ---
const vatsimId = await getVatsimId(userId);
if (!vatsimId) {
  return i.reply({ content: '❌ Could not retrieve your VATSIM ID. Please ensure your Discord is linked.', ephemeral: true });
}

// --- Send booking to VATSIM API ---
const bookingvatid = await sendBooking({
  callsign: pos,
  cid: vatsimId,
  start: startUTC,
  end: endUTC
});

if (!bookingvatid) {
  return i.reply({ content: '❌ Booking failed. Please try again later.', ephemeral: true });
}

      const bookingEmbed = new MessageEmbed()
        .setColor('#000000')
        .setTitle(pos)
        .setTimestamp(new Date())
        .addField('Date', date, false)
        .addField('Start', String(start), true)
        .addField('End', String(end), true)
        .addField('Controller', `<@${userId}>`, false)
        .setThumbnail(member.user.displayAvatarURL({ format: "png" }));
    
      if (eventName) bookingEmbed.addField('Event', eventName, false);
      if (extendedSectors.length > 0) {
        const display = extendedSectors.map(s => sectorCodeMap[s] || s);
        bookingEmbed.addField('Extended Sectors', display.join(', '), false);
      }
    
      for (const [roleId, label] of Object.entries(roleMap)) {
        if (member._roles.includes(roleId)) {
          bookingEmbed.setFooter({ text: label });
          break;
        }
      }
    
      const channel = s4d.client.channels.cache.get('1424637009686696040');
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
  bookingvatid // <-- new field added here
});
messages.set(userId, userBookings);

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
          await i.reply({
            content: '✅ Booking Created. No additional sectors available for extension.',
            ephemeral: true
          });
        } else {
          const options = availableSectors.map(sector => ({
            label: sector,
            value: `${sentMessage.id}|${sector}`
          }));
    
          const row = new MessageActionRow().addComponents(
            new MessageSelectMenu()
              .setCustomId('extend_sector_select')
              .setPlaceholder('Select sectors to extend into')
              .setMinValues(0)
              .setMaxValues(options.length)
              .addOptions(options)
          );
    
          await i.reply({
            content: '✅ Booking Created. Select sectors you want to extend into:',
            components: [row],
            ephemeral: true
          });
        }
      } else {
        await i.reply({
          content: '✅ Booking Created. To delete, run /deletebooking with the same position and date.',
          ephemeral: true
        });
      }
    });
    
    
    const messages = new Database('./messages.json')
    s4d.client.on('interactionCreate', async (interaction) => {
              if ((interaction.commandName) == 'openeventposition') {
        event.set(String((interaction.options.getString('position'))), (interaction.options.getString('date')));
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
          color: '#000000',
          title: 'Event Position Opened',
          fields: [
            {
              name: 'Date',
              value: date,
              inline: false
            },
            {
              name: 'Position',
              value: position,
              inline: false
            }
          ]
        };
    
        const channel = s4d.client.channels.cache.get('1424637009686696040');
        const sentMessage = await channel.send({ embeds: [embed] });
    
        eventclose.set(position, sentMessage.id);
    
        await interaction.reply({ content: (String(interaction.options.getString('position')) + ' opened!'), ephemeral: true, components: [] });
      }
    
        });
    
    s4d.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isSelectMenu()) return;
      if (interaction.customId !== 'extend_sector_select') return;
    
      console.log('✅ Select menu interaction received');
    
      try {
        const Database = require("easy-json-database");
        const Discord = require("discord.js");
        const messages = new Database("./messages.json");
    
        const sectorCodeMap = {
          "NZAA_CTR": "OCR",
          "NZCH-B_CTR": "BAY",
          "NZOH_CTR": "OHA",
          "NZCH-K_CTR": "KAI",
          "NZCH-T_CTR": "NAK",
          "NZCH-S_CTR": "STH"
        };
    
        const selections = interaction.values;
        console.log('🧠 Selected values:', selections);
    
        const userId = String(interaction.member.user.id);
        const userBookings = messages.get(userId);
        if (!Array.isArray(userBookings)) {
          console.log('❌ No bookings found for user');
          return;
        }
    
        const [messageId] = selections[0].split('|');
        const booking = userBookings.find(b => b.messageId === messageId);
        if (!booking) {
          console.log('❌ Booking not found for message ID:', messageId);
          return;
        }
    
        console.log('📦 Booking found:', booking);
    
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
    
        console.log('🚫 Unavailable sectors:', Array.from(unavailable));
    
        let updated = false;
    
        for (const selection of selections) {
          const [, sector] = selection.split('|');
          if (!unavailable.has(sector) && !booking.extendedSectors.includes(sector)) {
            booking.extendedSectors.push(sector);
            updated = true;
            console.log(`✅ Sector ${sector} added to booking`);
          } else {
            console.log(`⚠️ Sector ${sector} is unavailable or already added`);
          }
        }
    
        if (updated) {
          const channel = s4d.client.channels.cache.get('1424637009686696040');
          const msg = await channel.messages.fetch(messageId);
          const embed = msg.embeds[0];
          const newEmbed = new Discord.MessageEmbed()
            .setColor(embed.color)
            .setTitle(embed.title)
            .setTimestamp(embed.timestamp)
            .setThumbnail(embed.thumbnail?.url)
            .setFooter(embed.footer?.text ? { text: embed.footer.text } : null);
    
          for (const field of embed.fields) {
            if (field.name !== 'Extended Sectors') {
              newEmbed.addField(field.name, field.value, field.inline);
            }
          }
    
          if (booking.extendedSectors.length > 0) {
            const display = booking.extendedSectors.map(s => sectorCodeMap[s] || s);
            newEmbed.addField('Extended Sectors', display.join(', '), false);
          }
    
          await msg.edit({ embeds: [newEmbed] });
          console.log('🖊️ Embed updated');
    
          messages.set(userId, userBookings);
          console.log('💾 Database updated');
        }
    
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply({ content: '✅ Extended sectors updated.', components: [] });
        } else {
          await interaction.reply({ content: '✅ Extended sectors updated.', components: [], ephemeral: true });
        }
    
        console.log('📨 Interaction response sent');
    
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
    });
    
    
    const eventclose = new Database('./eventclose.json')
    s4d.client.on('interactionCreate', async (interaction) => {
              if ((interaction.commandName) == 'closeeventposition') {
        event.set(String((interaction.options.getString('position'))), '0/0');
        s4d.client.channels.cache.get('1424637009686696040').messages.fetch(eventclose.get(String((interaction.options.getString('position'))))).then(async (s4dmessage) =>{
           (s4dmessage).delete()
              await interaction.reply({ content: (String(interaction.options.getString('position')) + ' closed!'), ephemeral: true, components: [] });
    
        });}
    
        });
    
    s4d.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isSelectMenu()) return;
      if (interaction.customId !== 'mentor_booking_select') return;
    
      const Database = require("easy-json-database");
      const messages = new Database("./messages.json");
    
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
        const channel = s4d.client.channels.cache.get('1424637009686696040');
        const s4dmessage = await channel.messages.fetch(booking.messageId);
        await s4dmessage.react('👍');
    
        const guildId = s4d.client.guilds.cache.get('1424636974312198187').id;
        messageLink = `https://discord.com/channels/${guildId}/${channel.id}/${booking.messageId}`;
      } catch (err) {
        console.error('❌ Failed to react or fetch message:', err);
      }
    
      try {
        const guild = s4d.client.guilds.cache.get('1424636974312198187');
        const mentorMember = guild.members.cache.get(mentorId) || await guild.members.fetch(mentorId);
    
        await mentorMember.send({
          content: messageLink,
          embeds: [{
            color: '#000000',
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
    });
    
    
    s4d.client.on('interactionCreate', async (interaction) => {
              if ((interaction.commandName) == 'mentor') {
        const { MessageActionRow, MessageSelectMenu } = require('discord.js');
        const Database = require("easy-json-database");
        const messages = new Database("./messages.json");
    
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
    
        const row = new MessageActionRow().addComponents(
          new MessageSelectMenu()
            .setCustomId('mentor_booking_select')
            .setPlaceholder(`Select a booking to notify ${mentor.user.username}`)
            .addOptions(options)
        );
    
        await interaction.reply({
          content: `👨‍🏫 Select the booking you want to notify **${mentor.user.username}** about:`,
          components: [row],
          ephemeral: true
        });
    
      }
    
        });
    
    setInterval(async () => {
      const now = new Date();
      const currentYear = now.getFullYear();
    
      for (const userId of messages.keys()) {
        const userBookings = messages.get(userId);
    
        if (!Array.isArray(userBookings)) continue;
    
        const updatedBookings = [];
    
        for (const booking of userBookings) {
          const [day, month] = booking.date.split('/').map(Number);
          const endHour = Math.floor(booking.end / 100);
          const endMinute = booking.end % 100;
    
          const bookingEnd = new Date(currentYear, month - 1, day, endHour, endMinute);
    
          if (bookingEnd > now) {
            updatedBookings.push(booking);
          } else {
            try {
              const channel = s4d.client.channels.cache.get('1424637009686696040');
              const msg = await channel.messages.fetch(booking.messageId);
              await msg.delete();
            } catch (err) {
              console.warn(`⚠️ Could not delete expired booking message ${booking.messageId}`);
            }
          }
        }
    
        messages.set(userId, updatedBookings);
      }
    
      console.log(`🧹 Booking cleanup ran at ${now.toLocaleString()}`);
    }, 60 * 60 * 1000);
    
    return s4d
})();
