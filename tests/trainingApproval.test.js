const { test } = require('node:test');
const assert = require('node:assert/strict');

function stub(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = { exports, loaded: true };
}
stub('../src/data/databases', { settings: { get: () => ({ enabled: false }) } });
const { createAccess } = require('../src/services/access');
const { createBookingLifecycle } = require('../src/services/bookingLifecycle');
const { createInteractionHandlers } = require('../src/handlers/interactions');

const member = (id, roles) => ({ id, user: { id }, roles: { cache: new Set(roles) } });
const taylor = member('taylor', ['senior-staff']);

function setup({ mentorApproved = false, owner = 'sam' } = {}) {
  const booking = { messageId: 'post', mentorRequired: true, mentorApproved, position: 'NZCH_TWR', date: '15/11', start: '1800', end: '2000' };
  const bookings = [booking];
  const audits = [];
  const edits = [];
  const dms = [];
  const sendAuditLog = async e => audits.push(e);
  const messages = { all: () => [{ key: owner, data: bookings }], get: () => bookings, set: () => {} };
  const bookingLifecycle = createBookingLifecycle({
    client: { users: { fetch: async id => ({ send: async p => dms.push([id, p.content]) }) } },
    messages,
    fetchBookingMessage: async () => ({
      embeds: [{ color: 0, title: 'NZCH_TWR', fields: [{ name: 'Controller', value: `<@${owner}>` }] }],
      edit: async p => edits.push(p),
      reactions: { removeAll: async () => {} }
    }),
    sendAuditLog
  });
  const access = createAccess({ settings: { get: () => undefined }, env: { MENTOR_APPROVER_USER_IDS: 'taylor', BOARD_ROLE_ID: 'board', SENIOR_STAFF_ROLE_ID: 'senior-staff' } });
  const handlers = createInteractionHandlers({ access, messages, sendAuditLog, bookingLifecycle, eventThreadService: {} });
  const replies = [];
  const modals = [];
  const interaction = (who, extra) => ({
    member: who, user: { id: who.id }, reply: async p => replies.push(p), showModal: async m => modals.push(m), ...extra
  });
  return {
    booking, bookings, audits, edits, dms, replies, modals, bookingLifecycle,
    command: (who = taylor) => handlers.handleApproveBookingCommand(interaction(who, { commandName: 'Approve booking', targetMessage: { id: 'post' } })),
    submit: (reason, who = taylor) => handlers.handleApproveBookingSubmit(interaction(who, {
      customId: 'approve_booking:post', fields: { getTextInputValue: () => reason }
    }))
  };
}

test('training staff get a reason form for a booking awaiting mentor approval', async () => {
  const s = setup();
  await s.command();
  assert.equal(s.modals[0].data.custom_id, 'approve_booking:post');
  assert.equal(s.modals[0].components[0].components[0].data.required, true);
});

test('submitting approves the booking, stops the deletion timers, updates the post, DMs the controller and logs the reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.bookingLifecycle.scheduleMentorTagTimeout('sam', 'post');
  await s.submit('  Mentor unavailable, approved for OTS preparation  ');
  assert.equal(s.booking.mentorApproved, true);
  assert.equal(s.booking.mentorApprovedBy, 'taylor');
  assert.equal(s.edits[0].embeds[0].data.fields.find(f => f.name === 'Mentor').value, 'Approved by <@taylor> (training staff)');
  assert.match(s.dms[0][1], /approved by training staff/);
  const audit = s.audits.find(a => a.action === 'Booking Approved by Training Staff');
  assert.equal(audit.reason, 'Mentor unavailable, approved for OTS preparation');
  assert.equal(audit.actorId, 'taylor');
  t.mock.timers.tick(6 * 60 * 1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.bookings.length, 1, 'the 5-minute mentor tag timer must not delete an approved booking');
});

test('refusals: no permission, lapsed access, own booking, not a pending booking, blank reason', async () => {
  for (const [options, who, message] of [
    [{}, member('alex', ['senior-staff']), /don't have permission/],
    [{}, member('taylor', ['training-team']), /access to this action has lapsed/],
    [{ owner: 'taylor' }, taylor, /can't approve your own booking/],
    [{ mentorApproved: true }, taylor, /isn't a booking awaiting mentor approval/]
  ]) {
    const s = setup(options);
    await s.command(who);
    assert.match(s.replies[0].content, message);
    assert.equal(s.replies[0].ephemeral, true);
    assert.equal(s.modals.length, 0);
    assert.equal(s.audits[0].action, 'Action Refused');
  }
  const blank = setup();
  await blank.submit('   ');
  assert.match(blank.replies[0].content, /A reason is required/);
  assert.equal(blank.booking.mentorApproved, false);
});
