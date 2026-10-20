const { ratingRoleIds } = require('../constants');
const { parseStaffRoleIds, hasStaffRole } = require('./permissions');
function isEligibleMentor(member, ownerId) {
  const id = member?.id || member?.user?.id;
  if (!id || String(id) === String(ownerId) || member.user?.bot) return false;
  const roles = process.env.MENTOR_ROLE_IDS?.trim()
    ? parseStaffRoleIds(process.env.MENTOR_ROLE_IDS)
    : [ratingRoleIds.I1, ratingRoleIds.I3].filter(Boolean);
  return hasStaffRole(member, roles);
}
module.exports = { isEligibleMentor };
