function parseStaffRoleIds(value) {
  return [...new Set(String(value || '').split(',').map(id => id.trim()).filter(Boolean))];
}

function hasStaffRole(member, roleIds) {
  const roles = member?.roles;
  return roleIds.some(id => Array.isArray(roles) ? roles.includes(id) : Boolean(roles?.cache?.has(id)));
}

// Returns why `mentor` can't mentor `menteeId`, or null when they can. Fails closed when no training role is configured.
function getMentorRefusal(mentor, menteeId, trainingRoleId) {
  if (mentor?.user?.bot) return "Bots can't be mentors.";
  if ((mentor?.id ?? mentor?.user?.id) === menteeId) return "You can't be your own mentor.";
  if (!trainingRoleId || !hasStaffRole(mentor, [trainingRoleId])) {
    return `${mentor?.displayName || mentor?.user?.username || 'That member'} isn't a mentor or instructor.`;
  }
  return null;
}

module.exports = { parseStaffRoleIds, hasStaffRole, getMentorRefusal };
