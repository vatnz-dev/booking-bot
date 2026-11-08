const { test } = require('node:test');
const assert = require('node:assert/strict');

function stub(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = { exports, loaded: true };
}
stub('../src/data/databases', { settings: { get: () => ({ enabled: false }) } });
const { createAccess } = require('../src/services/access');
const { createInteractionHandlers } = require('../src/handlers/interactions');

const env = {
  BOT_OWNER_IDS: 'owner',
  BOARD_ROLE_ID: 'board',
  SENIOR_STAFF_ROLE_ID: 'senior-staff',
  BOOKING_MODERATOR_ROLE_IDS: 'events-team,board',
  EVENT_POSITION_USER_IDS: 'events-director',
  EVENT_PROMPT_ROLE_IDS: 'events-team'
};
function memorySettings() {
  const data = {};
  return { get: key => data[key], set: (key, value) => { data[key] = value; } };
}
const member = (id, roles) => ({ id, user: { id }, roles: { cache: new Set(roles) } });

test('roles grant directly; named users only while they hold Board or Senior Staff', () => {
  const access = createAccess({ settings: memorySettings(), env });
  assert.equal(access.can('booking-moderator', member('alex', ['events-team'])), 'ok');
  assert.equal(access.can('booking-moderator', member('ops', ['ops-team', 'senior-staff'])), 'denied');
  assert.equal(access.can('event-position', member('events-director', ['board'])), 'ok');
  assert.equal(access.can('event-position', member('events-director', ['events-team'])), 'lapsed');
  assert.equal(access.can('event-position', member('training-director', ['board'])), 'denied');
  assert.equal(access.can('event-position', null), 'denied');
  assert.equal(access.can('mentor-approver', member('anyone', ['board'])), 'denied');
});

test('owners come only from the environment', () => {
  const access = createAccess({ settings: memorySettings(), env });
  assert.equal(access.isOwner('owner'), true);
  assert.equal(access.isOwner('events-director'), false);
  assert.equal(createAccess({ settings: memorySettings(), env: {} }).isOwner('owner'), false);
});

test('the first change saves a permission list, which then overrides the environment', () => {
  const settings = memorySettings();
  const access = createAccess({ settings, env });
  const { before, after } = access.add('booking-moderator', 'roles', 'training');
  assert.deepEqual(before.roles, ['events-team', 'board']);
  assert.equal(before.source, 'environment');
  assert.deepEqual(after.roles, ['events-team', 'board', 'training']);
  const changedEnv = createAccess({ settings, env: { ...env, BOOKING_MODERATOR_ROLE_IDS: 'someone-else' } });
  assert.equal(changedEnv.can('booking-moderator', member('t', ['training'])), 'ok');
  assert.equal(changedEnv.can('booking-moderator', member('s', ['someone-else'])), 'denied');
  assert.deepEqual(access.remove('booking-moderator', 'roles', 'board').after.roles, ['events-team', 'training']);
  assert.deepEqual(access.mentions('event-prompt'), ['<@&events-team>']);
});

test('the startup check warns about named users who left or lost their qualifying role', async () => {
  const access = createAccess({ settings: memorySettings(), env: { ...env, EVENT_POSITION_USER_IDS: 'gone,demoted,fine', MENTOR_APPROVER_USER_IDS: '' } });
  const members = { demoted: member('demoted', ['events-team']), fine: member('fine', ['board']) };
  const audits = [];
  await access.checkNamedUsers({ members: { fetch: async id => members[id] ?? Promise.reject(new Error('Unknown Member')) } }, async e => audits.push(e));
  assert.deepEqual(audits.map(a => a.reason), [
    "<@gone> has left the server, so their event-position access doesn't work.",
    "<@demoted> no longer holds the Board or Senior Staff role, so their event-position access doesn't work."
  ]);
});

test('event-thread buttons refuse members without the permission, and prompts ping only event-prompt roles', async () => {
  const { createEventThreadService } = require('../src/services/eventThreads');
  const audits = [];
  const sent = [];
  const service = createEventThreadService({
    access: createAccess({ settings: memorySettings(), env: { ...env, EVENT_THREAD_ROLE_IDS: 'events-team,board' } }),
    sendAuditLog: async e => audits.push(e),
    eventThreads: { get: () => undefined, set: () => {} },
    getLogChannel: async () => ({ id: 'log', send: async payload => { sent.push(payload); return { id: 'prompt' }; } })
  });
  let response;
  await service.handleEventThreadButton({
    member: member('ops', ['ops-team', 'senior-staff']), user: { id: 'ops' }, customId: 'event_thread_create:uid',
    reply: async payload => { response = payload; }
  });
  assert.match(response.content, /don't have permission/);
  assert.equal(audits[0].action, 'Action Refused');
  await service.postEventThreadPrompt({ uid: 'uid', title: 'Christmas Fly-in', startUtcISO: '2026-12-20T06:00:00Z', endUtcISO: '2026-12-20T09:00:00Z' });
  assert.match(sent[0].content, /^<@&events-team> Event thread check required\.$/);
});

function maintenance({ userId = 'owner', subcommand = 'add', permission = 'booking-moderator', target = { role: { id: 'training', managed: false } } } = {}) {
  const settings = memorySettings();
  const audits = [];
  const access = createAccess({ settings, env });
  const handlers = createInteractionHandlers({ access, sendAuditLog: async e => audits.push(e), bookingLifecycle: {}, eventThreadService: {} });
  let response;
  const run = () => handlers.handleMaintenance({
    user: { id: userId }, guildId: 'vatnz', commandName: 'maintenance',
    options: { getSubcommand: () => subcommand, getString: () => permission, get: () => target },
    reply: async payload => { response = payload; }
  });
  return { run, audits, access, response: () => response };
}

test('/maintenance refuses anyone who is not an owner, and logs it', async () => {
  const m = maintenance({ userId: 'events-director' });
  await m.run();
  assert.match(m.response().content, /Only bot owners/);
  assert.equal(m.audits[0].action, 'Action Refused');
  assert.equal(m.access.can('booking-moderator', member('t', ['training'])), 'denied');
});

test('/maintenance refuses @everyone and managed roles', async () => {
  for (const [role, message] of [[{ id: 'vatnz' }, /@everyone can't/], [{ id: 'bot-role', managed: true }, /managed by Discord/]]) {
    const m = maintenance({ target: { role } });
    await m.run();
    assert.match(m.response().content, message);
    assert.equal(m.access.list().find(p => p.permission === 'booking-moderator').source, 'environment');
  }
});

test('/maintenance add logs the change with the list before and after', async () => {
  const m = maintenance();
  await m.run();
  assert.equal(m.access.can('booking-moderator', member('t', ['training'])), 'ok');
  const [audit] = m.audits;
  assert.equal(audit.action, 'Access Changed');
  assert.equal(audit.actorId, 'owner');
  assert.deepEqual(audit.fields.map(f => f.value), ['booking-moderator', '<@&events-team>, <@&board>', '<@&events-team>, <@&board>, <@&training>']);
  assert.equal(m.response().ephemeral, true);
});

test('/maintenance can grant a named user, and list shows every permission and its source', async () => {
  const m = maintenance({ permission: 'mentor-approver', target: { user: { id: 'training-manager' } } });
  await m.run();
  assert.equal(m.access.can('mentor-approver', member('training-manager', ['senior-staff'])), 'ok');
  const list = maintenance({ subcommand: 'list' });
  await list.run();
  assert.match(list.response().content, /\*\*booking-moderator\*\* \(environment\): <@&events-team>, <@&board>/);
  assert.match(list.response().content, /\*\*mentor-approver\*\* \(environment\): Nobody/);
  assert.deepEqual(list.response().allowedMentions, { parse: [] });
});
