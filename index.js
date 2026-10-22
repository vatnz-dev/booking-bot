(async () => {
  require('dotenv').config();

  const dns = require('dns');
  const Discord = require('discord.js');
  const { Client, GatewayIntentBits, Partials } = require('discord.js');
  const syncCommands = require('discord-sync-commands');

  const path = require('path');
  const { log, logFailures, describeSettings } = require('./src/utils/log');
  const { event, messages, eventclose, eventThreads, endorsementWarnings, settings, dbPaths } = require('./src/data/databases');
  const commandDefinitions = require('./src/commands/definitions');
  const { GUILD_ID } = require('./src/constants');
  if (!GUILD_ID) {
    log('error', 'config_missing', { setting: 'GUILD_ID', message: 'GUILD_ID must be set' });
    process.exit(1);
  }
  if (process.env.STAFF_ROLE_IDS || process.env.STAFF_ROLE_ID) {
    log('warn', 'setting_unused', { setting: 'STAFF_ROLE_IDS', message: 'STAFF_ROLE_IDS is no longer used and grants nothing; use the per-permission settings instead' });
  }
  const { createAccess } = require('./src/services/access');
  const { getVatnzEventPositions } = require('./src/services/positions');
  const { createDiscordHelpers } = require('./src/services/discordHelpers');
  const { createAuditLogger } = require('./src/services/auditLog');
  const { createBookingLifecycle } = require('./src/services/bookingLifecycle');
  const { createEventThreadService } = require('./src/services/eventThreads');
  const { createEndorsementWarningService } = require('./src/services/soloEndorsements');
  const { getVatsimId } = require('./src/services/vatsim');
  const { createInteractionHandlers } = require('./src/handlers/interactions');
  const { registerReadyHandlers, registerGuildLock } = require('./src/handlers/ready');
  const { startStatsimHealthScheduler } = require('./src/services/traffic');

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

  const access = createAccess({ settings });

  const discordHelpers = createDiscordHelpers({ client });
  const { sendAuditLog } = createAuditLogger({
    getLogChannel: discordHelpers.getLogChannel,
    getBookingMessageLink: discordHelpers.getBookingMessageLink,
    auditFilePath: path.join(path.dirname(dbPaths.messages), 'audit.jsonl')
  });

  process.on('unhandledRejection', error => {
    log('error', 'unhandled_rejection', { error });
    sendAuditLog({ action: 'Unhandled Error', actorLabel: 'System', reason: error?.message || String(error), color: '#D9534F' }).catch(() => {});
  });
  // Node can't safely continue after a synchronous crash; log it and let Docker restart the container.
  process.on('uncaughtException', error => {
    log('error', 'uncaught_exception', { error });
    process.exit(1);
  });
  client.on('error', error => log('error', 'discord_client_error', { error }));
  client.on('shardError', (error, shardId) => log('error', 'discord_shard_error', { shardId, error }));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      // Database writes are synchronous, so nothing is mid-write when a signal is handled.
      log('info', 'shutdown', { signal });
      setTimeout(() => process.exit(0), 5000).unref();
      Promise.resolve(client.destroy()).finally(() => process.exit(0));
    });
  }

  log('info', 'startup', {
    version: require('./package.json').version,
    commit: process.env.GIT_COMMIT || 'unknown',
    settings: describeSettings(process.env)
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
    access
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
    access,
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
    startStatsimHealthScheduler,
    getBookingChannel: discordHelpers.getBookingChannel,
    getVatnzEventPositions,
    startBookingCleanupScheduler: bookingLifecycle.startBookingCleanupScheduler,
    startEventThreadScheduler: eventThreadService.startEventThreadScheduler,
    startEndorsementWarningScheduler: endorsementWarningService.startEndorsementWarningScheduler
  });

  interactionHandlers.registerInteractionHandlers();
  client.on('messageReactionAdd', bookingLifecycle.handleMentorApprovalReaction);

  registerGuildLock({ client, guildId: GUILD_ID });
  client.once('clientReady', logFailures('named_user_access_check', {}, async () => {
    const guild = await client.guilds.fetch(GUILD_ID);
    await access.checkNamedUsers(guild, sendAuditLog);
  }));

  // Register in the VATNZ server only, then remove any commands left over from global registration.
  syncCommands(client, commandDefinitions, { guildId: GUILD_ID })
    .then(() => syncCommands(client, [], {}))
    .catch(error => log('error', 'command_sync_failed', { error }));

  client.login(process.env.DISCORD_TOKEN).catch(error => {
    log('error', 'login_failed', { error });
    process.exit(1);
  });

  return s4d;
})();
