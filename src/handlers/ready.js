const {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require('discord.js');

function registerReadyHandlers({
  client,
  event,
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
      await bookingChannel.send({
        content: String(' '),
        components: [new ActionRowBuilder().addComponents(plan)],
        embeds: [planEmbed]
      });
    }
  });
}

module.exports = {
  registerReadyHandlers
};
