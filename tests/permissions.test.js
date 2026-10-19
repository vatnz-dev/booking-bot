const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { parseStaffRoleIds, hasStaffRole } = require('../src/utils/permissions');

test('staff roles accept a trimmed, deduplicated comma-separated list', () => {
  assert.deepEqual(parseStaffRoleIds(' senior, ops, board, senior, ,'), ['senior', 'ops', 'board']);
  assert.deepEqual(parseStaffRoleIds(undefined), []);
});

test('staff authorization works for cached and raw Discord members and fails closed', () => {
  const roleIds = ['senior', 'ops', 'board'];
  for (const id of roleIds) {
    assert.equal(hasStaffRole({ roles: { cache: new Set([id]) } }, roleIds), true);
    assert.equal(hasStaffRole({ roles: [id] }, roleIds), true);
  }
  for (const member of [null, {}, { roles: [] }, { roles: { cache: new Set(['controller']) } }]) {
    assert.equal(hasStaffRole(member, roleIds), false);
  }
  assert.equal(hasStaffRole({ roles: ['senior'] }, []), false);
});

test('plural staff configuration takes precedence and legacy single role remains supported', () => {
  function readRoles(plural, legacy) {
    return JSON.parse(execFileSync(process.execPath, ['-e',
      "process.stdout.write(JSON.stringify(require('./src/constants').STAFF_ROLE_IDS))"
    ], { cwd: require('node:path').resolve(__dirname, '..'),
      env: { ...process.env, STAFF_ROLE_IDS: plural, STAFF_ROLE_ID: legacy }, encoding: 'utf8' }));
  }
  assert.deepEqual(readRoles('senior,ops,board', 'legacy'), ['senior', 'ops', 'board']);
  assert.deepEqual(readRoles('', 'legacy'), ['legacy']);
  assert.deepEqual(readRoles('', ''), []);
});
