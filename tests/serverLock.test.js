const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.GUILD_ID = 'vatnz';
function stub(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = { exports, loaded: true };
}
stub('../src/data/databases', { settings: { get: () => ({ enabled: false }) } });
const { createInteractionHandlers } = require('../src/handlers/interactions');
const { registerGuildLock } = require('../src/handlers/ready');

function captureLogs(t) {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(JSON.parse(line)));
  return lines;
}

test('interactions from another server are ignored and logged', async t => {
  const lines = captureLogs(t);
  let onInteraction;
  createInteractionHandlers({ client: { on: (_, fn) => { onInteraction = fn; } }, bookingLifecycle: {}, eventThreadService: {} })
    .registerInteractionHandlers();
  await onInteraction({
    id: 'i-1', guildId: 'other', commandName: 'deletebookings', user: { id: 'sam' },
    isChatInputCommand: () => assert.fail('Interactions from other servers must not be handled')
  });
  assert.equal(lines.find(l => l.event === 'interaction_other_guild').guildId, 'other');
  assert.equal(lines.find(l => l.event === 'interaction').result, 'ignored');
});

test('the bot leaves any server other than VATNZ, on join and at startup', async t => {
  const lines = captureLogs(t);
  const handlers = {};
  const left = [];
  const guild = (id, name) => ({ id, name, leave: async () => left.push(id) });
  const client = {
    on: (event, fn) => { handlers[event] = fn; },
    once: (event, fn) => { handlers[event] = fn; },
    guilds: { cache: [guild('vatnz', 'VATNZ'), guild('stale', 'Old server')] }
  };
  registerGuildLock({ client, guildId: 'vatnz' });
  await handlers.clientReady();
  await handlers.guildCreate(guild('new', 'Someone else'));
  await handlers.guildCreate(guild('vatnz', 'VATNZ'));
  assert.deepEqual(left, ['stale', 'new']);
  assert.deepEqual(lines.filter(l => l.event === 'left_guild').map(l => l.guildName), ['Old server', 'Someone else']);
});
