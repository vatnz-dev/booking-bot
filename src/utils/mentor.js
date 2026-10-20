const { STAFF_ROLE_IDS } = require('../constants');
const { hasStaffRole } = require('./permissions');

function isEligibleMentor(member, ownerId) {
  const id = member?.id || member?.user?.id;
  if (!id || String(id) === String(ownerId) || member.user?.bot) return false;
  return hasStaffRole(member, STAFF_ROLE_IDS);
}

module.exports = { isEligibleMentor };
