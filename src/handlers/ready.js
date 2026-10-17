const {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require('discord.js');

function isBookingPanel(message, botId) {
  return message.author?.id === botId && message.components.some(row =>
    row.components.some(component => component.customId === 'plan')
  );
}

async function ensureBookingPanel({ channel, botId, settings, payload }) {
  const saved = settings.get('bookingPanel');
  if (saved?.channelId === channel.id && saved.messageId) {
    try {
      const message = await channel.messages.fetch({ message: saved.messageId, force: true });
      if (isBookingPanel(message, botId)) return message;
    } catch (error) {
      if (error.code !== 10008) throw error;
    }
  }

  // Adopt panels posted before message IDs were persisted, including older history.
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const existing = batch.find(message => isBookingPanel(message, botId));
    if (existing) {
      settings.set('bookingPanel', { channelId: channel.id, messageId: existing.id });
      return existing;
    }
    if (batch.size < 100) break;
    before = batch.last().id;
  }

  const message = await channel.send(payload);
  settings.set('bookingPanel', { channelId: channel.id, messageId: message.id });
  return message;
}

function registerReadyHandlers({
  client,
  event,
  settings,
  getBookingChannel,
  getVatnzEventPositions,
  startBookingCleanupScheduler,
  startEventThreadScheduler,
  startEndorsementWarningScheduler
}) {
  client.once('clientReady', () => {
    console.log(`${client.user.tag} is alive!`);
    startBookingCleanupScheduler();
    startEventThreadScheduler();
    startEndorsementWarningScheduler?.();
  });

  client.on('clientReady', async () => {
    client.user.setPresence({ status: "online", activities: [{ name: 'ATC Bookings', type: ActivityType.Watching }] });
  });

  client.on('clientReady', async () => {
    const managedEventPositions = await getVatnzEventPositions();
    for (const position of managedEventPositions) {
      if (event.get(position) === undefined) {
        event.set(position, '0/0');
      }
    }

    const planEmbed = new EmbedBuilder()
      .setColor('#000000')
      .setTitle(String('Book A Controlling Session'))
      .setDescription(String('This is a booking system for VATNZ controlling sessions. If you book a position, you are expected to be online for that callsign during the booked time. This is still VATSIM, not real life: if plans change, that is fine, but please delete your booking so another controller can use the position.'))
      .addFields(
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

    const plan = new ButtonBuilder()
      .setCustomId('plan')
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Book Controlling Session');

    const bookingChannel = await getBookingChannel();
    if (bookingChannel?.send) {
      try {
        const panel = await ensureBookingPanel({
          channel: bookingChannel,
          botId: client.user.id,
          settings,
          payload: {
            content: String(' '),
            components: [new ActionRowBuilder().addComponents(plan)],
            embeds: [planEmbed]
          }
        });
        console.log(`Booking panel ready: ${panel.id}`);
      } catch (error) {
        console.error('Could not ensure booking panel:', error);
      }
    }
  });
}

module.exports = {
  registerReadyHandlers,
  ensureBookingPanel
};
