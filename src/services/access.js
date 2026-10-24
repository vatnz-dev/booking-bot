const { parseIdList, hasAnyRole } = require('../utils/permissions');

// Each permission starts from one environment variable; a /maintenance change saves its own list, which then wins.
const PERMISSIONS = {
  'booking-moderator': { env: 'BOOKING_MODERATOR_ROLE_IDS', kind: 'roles', label: "Edit or delete other controllers' bookings" },
  'event-position': { env: 'EVENT_POSITION_USER_IDS', kind: 'users', label: 'Open or close event positions' },
  'event-thread': { env: 'EVENT_THREAD_ROLE_IDS', kind: 'roles', label: 'Create or decline event threads' },
  'event-prompt': { env: 'EVENT_PROMPT_ROLE_IDS', kind: 'roles', label: 'Pinged by event-thread prompts' },
  'mentor-approver': { env: 'MENTOR_APPROVER_USER_IDS', kind: 'users', label: "Approve mentor bookings on a mentor's behalf" }
};
const REFUSALS = {
  denied: "You don't have permission to do that.",
  lapsed: 'Your access to this action has lapsed.',
  owner: 'Only bot owners can use this command.'
};
const SETTING_KEY = 'access';

function createAccess({ settings, env = process.env }) {
  const owners = parseIdList(env.BOT_OWNER_IDS);
  // Named users only count while they still hold one of these roles, so access lapses when they step down.
  const qualifyingRoles = parseIdList(`${env.BOARD_ROLE_ID || ''},${env.SENIOR_STAFF_ROLE_ID || ''}`);

  function grants(permission) {
    const saved = settings.get(SETTING_KEY)?.[permission];
    if (saved) return { roles: [...saved.roles], users: [...saved.users], source: 'saved' };
    const { env: name, kind } = PERMISSIONS[permission];
    const ids = parseIdList(env[name]);
    return { roles: kind === 'roles' ? ids : [], users: kind === 'users' ? ids : [], source: 'environment' };
  }

  // Returns 'ok', 'denied' or 'lapsed'.
  function can(permission, member) {
    const { roles, users } = grants(permission);
    if (hasAnyRole(member, roles)) return 'ok';
    if (!users.includes(member?.id ?? member?.user?.id)) return 'denied';
    return hasAnyRole(member, qualifyingRoles) ? 'ok' : 'lapsed';
  }

  function change(permission, kind, id, add) {
    const before = grants(permission);
    const after = { roles: [...before.roles], users: [...before.users] };
    after[kind] = add ? [...new Set([...after[kind], id])] : after[kind].filter(existing => existing !== id);
    settings.set(SETTING_KEY, { ...(settings.get(SETTING_KEY) || {}), [permission]: after });
    return { before, after: { ...after, source: 'saved' } };
  }

  async function checkNamedUsers(guild, sendAuditLog) {
    for (const permission of Object.keys(PERMISSIONS)) {
      for (const userId of grants(permission).users) {
        const member = await guild.members.fetch(userId).catch(() => null);
        const problem = !member ? 'has left the server' : !hasAnyRole(member, qualifyingRoles) ? 'no longer holds the Board or Senior Staff role' : null;
        if (!problem) continue;
        await sendAuditLog({
          action: 'Access Warning',
          actorLabel: 'System',
          reason: `<@${userId}> ${problem}, so their ${permission} access doesn't work.`,
          fields: [{ name: 'Permission', value: permission, inline: true }, { name: 'User', value: `<@${userId}> (${userId})`, inline: true }],
          color: '#FF9900'
        });
      }
    }
  }

  return {
    can,
    isOwner: userId => owners.includes(String(userId)),
    mentions: permission => {
      const { roles, users } = grants(permission);
      return [...roles.map(id => `<@&${id}>`), ...users.map(id => `<@${id}>`)];
    },
    list: () => Object.keys(PERMISSIONS).map(permission => ({ permission, ...grants(permission) })),
    add: (permission, kind, id) => change(permission, kind, id, true),
    remove: (permission, kind, id) => change(permission, kind, id, false),
    checkNamedUsers
  };
}

function describeGrants({ roles, users }) {
  const parts = [...roles.map(id => `<@&${id}>`), ...users.map(id => `<@${id}>`)];
  return parts.length ? parts.join(', ') : 'Nobody';
}

module.exports = { PERMISSIONS, REFUSALS, createAccess, describeGrants };
