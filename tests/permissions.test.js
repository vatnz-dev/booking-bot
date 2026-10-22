const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { parseStaffRoleIds, hasStaffRole, getMentorRefusal } = require('../src/utils/permissions');

test('only training team members other than the mentee can mentor, and an unset role fails closed', () => {
  const mentor = (id, roles, extra = {}) => ({ id, displayName: id, roles: { cache: new Set(roles) }, user: { id }, ...extra });
  assert.equal(getMentorRefusal(mentor('morgan', ['training']), 'sam', 'training'), null);
  assert.equal(getMentorRefusal(mentor('sam', ['training']), 'sam', 'training'), "You can't be your own mentor.");
  assert.equal(getMentorRefusal(mentor('bot', ['training'], { user: { id: 'bot', bot: true } }), 'sam', 'training'), "Bots can't be mentors.");
  assert.equal(getMentorRefusal(mentor('alex', ['controller']), 'sam', 'training'), "alex isn't a mentor or instructor.");
  assert.equal(getMentorRefusal(mentor('morgan', ['training']), 'sam', ''), "morgan isn't a mentor or instructor.");
  assert.equal(getMentorRefusal({ user: { id: 'sam' }, roles: ['training'] }, 'sam', 'training'), "You can't be your own mentor.");
  assert.equal(getMentorRefusal(null, 'sam', 'training'), "That member isn't a mentor or instructor.");
});

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

test('configured rating roles drive tier checks and booking labels without hard-coded fallbacks', () => {
  const ratings = ['S1', 'S2', 'S3', 'I3', 'C1', 'C3', 'I1'];
  function readConfiguration(configured) {
    return JSON.parse(execFileSync(process.execPath, ['-e', `
      const { ratingRoleIds, roleMap, FSS_ROLE_ID } = require('./src/constants');
      const { getControllerTier } = require('./src/services/positions');
      const tier = ids => getControllerTier({ roles: { cache: new Set(ids) } });
      process.stdout.write(JSON.stringify({ ratingRoleIds, roleMap, FSS_ROLE_ID,
        tiers: Object.values(ratingRoleIds).map(id => tier([id])),
        highestTier: tier(Object.values(ratingRoleIds)), unknownTier: tier(['unknown']) }));
    `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8',
      env: { ...process.env, FSS_ROLE_ID: configured ? ' fss-custom ' : '',
        ...Object.fromEntries(ratings.map(rating => [`${rating}_ROLE_ID`, configured ? ` ${rating}-custom ` : ''])) } }));
  }
  const configured = readConfiguration(true);
  assert.equal(configured.FSS_ROLE_ID, 'fss-custom');
  assert.deepEqual(configured.tiers, ratings);
  assert.equal(configured.highestTier, 'I3');
  assert.equal(configured.unknownTier, 'UNRATED');
  for (const rating of ratings) {
    assert.equal(configured.ratingRoleIds[rating], `${rating}-custom`);
    assert.ok(configured.roleMap[`${rating}-custom`].startsWith(`${rating} - `));
  }
  const empty = readConfiguration(false);
  assert.equal(empty.FSS_ROLE_ID, '');
  assert.deepEqual(empty.roleMap, {});
  assert.deepEqual(empty.tiers, ratings.map(() => 'UNRATED'));
});
