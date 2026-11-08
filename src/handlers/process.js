const { log } = require('../utils/log');

const CRASH_POST_WAIT_MS = 3000;

// Errors nobody caught, and the Discord connection's state, are logged; reconnecting is left to discord.js.
function registerProcessHandlers({ processRef = process, client, sendAuditLog, exit = code => process.exit(code) }) {
  const auditError = error => sendAuditLog({ action: 'Unhandled Error', actorLabel: 'System', reason: error?.message || String(error), color: '#D9534F' });

  processRef.on('unhandledRejection', error => {
    log('error', 'unhandled_rejection', { error });
    auditError(error).catch(() => {});
  });

  // Node can't safely continue after a synchronous crash. The audit file is written straight away;
  // the log-channel post gets a few seconds, then Docker restarts the container.
  processRef.on('uncaughtException', error => {
    log('error', 'uncaught_exception', { error });
    const timer = setTimeout(() => exit(1), CRASH_POST_WAIT_MS);
    timer.unref?.();
    Promise.resolve().then(() => auditError(error)).catch(() => {}).finally(() => { clearTimeout(timer); exit(1); });
  });

  client.on('error', error => log('error', 'discord_client_error', { error }));
  client.on('shardError', (error, shardId) => log('error', 'discord_shard_error', { shardId, error }));
  client.on('shardDisconnect', (event, shardId) => log('warn', 'discord_disconnected', { shardId, code: event?.code, reason: event?.reason || undefined }));
  client.on('shardReconnecting', shardId => log('warn', 'discord_reconnecting', { shardId }));
  client.on('shardResume', (shardId, replayedEvents) => log('info', 'discord_resumed', { shardId, replayedEvents }));
}

module.exports = { registerProcessHandlers, CRASH_POST_WAIT_MS };
