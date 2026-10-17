(async () => {
  require('dotenv').config();

  const dns = require('dns');
  const Discord = require('discord.js');
  const { Client, GatewayIntentBits, Partials } = require('discord.js');
  const syncCommands = require('discord-sync-commands');

  const { event, messages, eventclose, eventThreads, endorsementWarnings, settings } = require('./src/data/databases');
  const commandDefinitions = require('./src/commands/definitions');
  const { STAFF_ROLE_ID } = require('./src/constants');
  const { getVatnzEventPositions } = require('./src/services/positions');
  const { createDiscordHelpers } = require('./src/services/discordHelpers');
  const { createAuditLogger } = require('./src/services/auditLog');
  const { createBookingLifecycle } = require('./src/services/bookingLifecycle');
  const { createEventThreadService } = require('./src/services/eventThreads');
  const { createEndorsementWarningService } = require('./src/services/soloEndorsements');
  const { getVatsimId } = require('./src/services/vatsim');
  const { createInteractionHandlers } = require('./src/handlers/interactions');
  const { registerReadyHandlers } = require('./src/handlers/ready');

  dns.setDefaultResultOrder?.('ipv4first');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User]
  });

  const s4d = {
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
      if (!client) throw new Error('You cannot perform message operations without a Discord.js client');
      if (!client.readyTimestamp) throw new Error('You cannot perform message operations while the bot is not connected to the Discord API');
    }
  };

  function isStaffMember(member) {
    return Boolean(member?.roles?.cache?.has(STAFF_ROLE_ID));
  }

  const discordHelpers = createDiscordHelpers({ client });
  const { sendAuditLog } = createAuditLogger({
    getLogChannel: discordHelpers.getLogChannel,
    getBookingMessageLink: discordHelpers.getBookingMessageLink
  });

  let eventThreadService;

  const bookingLifecycle = createBookingLifecycle({
    client,
    messages,
    fetchBookingMessage: discordHelpers.fetchBookingMessage,
    getBookingMessageLink: discordHelpers.getBookingMessageLink,
    sendAuditLog,
    refreshEventCoverageNotificationsForBooking: (...args) => eventThreadService?.refreshEventCoverageNotificationsForBooking?.(...args)
  });

  eventThreadService = createEventThreadService({
    eventThreads,
    messages,
    fetchDiscordChannel: discordHelpers.fetchDiscordChannel,
    getBookingChannel: discordHelpers.getBookingChannel,
    getLogChannel: discordHelpers.getLogChannel,
    fetchBookingMessage: discordHelpers.fetchBookingMessage,
    sendAuditLog,
    clearMentorTimers: bookingLifecycle.clearMentorTimers,
    clearExtensionSelectionTimer: bookingLifecycle.clearExtensionSelectionTimer,
    clearBookingReminderTimer: bookingLifecycle.clearBookingReminderTimer,
    rescheduleMentorTimers: bookingLifecycle.rescheduleMentorTimers,
    scheduleBookingReminder: bookingLifecycle.scheduleBookingReminder,
    isStaffMember
  });

  const endorsementWarningService = createEndorsementWarningService({
    client,
    messages,
    endorsementWarnings,
    getVatsimId
  });

  const interactionHandlers = createInteractionHandlers({
    client,
    event,
    eventclose,
    messages,
    isStaffMember,
    getBookingChannel: discordHelpers.getBookingChannel,
    fetchBookingMessage: discordHelpers.fetchBookingMessage,
    sendAuditLog,
    eventThreadService,
    bookingLifecycle
  });

  registerReadyHandlers({
    client,
    event,
    settings,
    getBookingChannel: discordHelpers.getBookingChannel,
    getVatnzEventPositions,
    startBookingCleanupScheduler: bookingLifecycle.startBookingCleanupScheduler,
    startEventThreadScheduler: eventThreadService.startEventThreadScheduler,
    startEndorsementWarningScheduler: endorsementWarningService.startEndorsementWarningScheduler
  });

  interactionHandlers.registerInteractionHandlers();
  client.on('messageReactionAdd', bookingLifecycle.handleMentorApprovalReaction);

  syncCommands(client, commandDefinitions, {
    debug: false
  });

  client.login(process.env.DISCORD_TOKEN);

  return s4d;
})();
