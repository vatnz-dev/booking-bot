const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.TRAINING_TEAM_ROLE_ID = 'training';
function stub(path, exports) {
  require.cache[require.resolve(path)] = { exports, loaded: true };
}
stub('../src/data/databases', { settings: { get: () => ({ enabled: false }) } });
const { createBookingLifecycle } = require('../src/services/bookingLifecycle');
const { createInteractionHandlers } = require('../src/handlers/interactions');

function setup(mentorRoles) {
  const booking = { messageId: 'post', mentorRequired: true, mentorId: 'morgan', mentorApproved: false, position: 'NZCH_TWR' };
  const audits = [];
  const edits = [];
  const lifecycle = createBookingLifecycle({
    messages: { all: () => [{ key: 'sam', data: [booking] }], set: () => {} },
    fetchBookingMessage: async () => ({
      embeds: [{ color: 0, title: 'NZCH_TWR', fields: [] }],
      edit: async payload => edits.push(payload),
      reactions: { removeAll: async () => {} }
    }),
    sendAuditLog: async entry => audits.push(entry)
  });
  const reaction = {
    emoji: { name: '\u{1F44D}' },
    message: { id: 'post', guild: { members: { fetch: async id => ({ id, user: { id }, roles: { cache: new Set(mentorRoles) } }) } } }
  };
  return { booking, audits, edits, approve: user => lifecycle.handleMentorApprovalReaction(reaction, user) };
}

test('tagged mentor with the training role approves the booking', async () => {
  const { booking, audits, edits, approve } = setup(['training']);
  await approve({ id: 'morgan', bot: false });
  assert.equal(booking.mentorApproved, true);
  assert.equal(edits.length, 1);
  assert.equal(audits[0].action, 'Mentor Approved Booking');
});

test('mentor who lost the training role cannot approve, and the refusal is logged', async () => {
  const { booking, audits, edits, approve } = setup(['controller']);
  await approve({ id: 'morgan', bot: false });
  assert.equal(booking.mentorApproved, false);
  assert.equal(edits.length, 0);
  assert.equal(audits[0].action, 'Mentor Approval Refused');
});

test('someone other than the tagged mentor cannot approve', async () => {
  const { booking, audits, approve } = setup(['training']);
  await approve({ id: 'alex', bot: false });
  assert.equal(booking.mentorApproved, false);
  assert.equal(audits.length, 0);
});

test('/mentor refuses a self-tag privately, logs it and offers no booking menu', async () => {
  const audits = [];
  const { handleMentor } = createInteractionHandlers({
    messages: { get: () => assert.fail('Refused requests must not read bookings') },
    sendAuditLog: async entry => audits.push(entry),
    bookingLifecycle: {}, eventThreadService: {}
  });
  let response;
  await handleMentor({
    member: { user: { id: 'sam' } },
    options: { getMember: () => ({ id: 'sam', displayName: 'Sam', user: { id: 'sam' }, roles: { cache: new Set(['training']) } }) },
    reply: async payload => { response = payload; }
  });
  assert.equal(response.ephemeral, true);
  assert.match(response.content, /can't be your own mentor/);
  assert.equal(response.components, undefined);
  assert.equal(audits[0].action, 'Mentor Request Refused');
});
