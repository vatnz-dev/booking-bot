const { hasStaffRole } = require('./permissions');

function isEligibleMentor(member, ownerId) {
  const id = member?.id || member?.user?.id;
  if (!id || String(id) === String(ownerId) || member.user?.bot) return false;
  const roleId = (process.env.MENTOR_ROLE_ID || '').trim();
  return Boolean(roleId) && hasStaffRole(member, [roleId]);
}

module.exports = { isEligibleMentor };
