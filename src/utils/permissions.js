function parseStaffRoleIds(value) {
  return [...new Set(String(value || '').split(',').map(id => id.trim()).filter(Boolean))];
}

function hasStaffRole(member, roleIds) {
  const roles = member?.roles;
  return roleIds.some(id => Array.isArray(roles) ? roles.includes(id) : Boolean(roles?.cache?.has(id)));
}

module.exports = { parseStaffRoleIds, hasStaffRole };
