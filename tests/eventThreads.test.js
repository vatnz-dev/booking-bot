const { test } = require('node:test');
const assert = require('node:assert/strict');

let calendar = '';
require.cache[require.resolve('../src/utils/http')] = { loaded: true, exports: { get: async () => ({ data: calendar }) } };
const { DateTime } = require('luxon');
const { createDiscordHelpers } = require('../src/services/discordHelpers');
const { pruneEventRecords } = require('../src/services/housekeeping');
const { createAccess } = require('../src/services/access');
const { createEventThreadService, parseVatnzIcsEvents, buildEventEmbed } = require('../src/services/eventThreads');

const ics = events => ['BEGIN:VCALENDAR', ...events.flatMap(e => [
  'BEGIN:VEVENT', `UID:${e.uid}`, `SUMMARY:${e.title}`, `DTSTART:${e.start}`, `DTEND:${e.end}`, ...(e.url ? [`URL:${e.url}`] : []), 'END:VEVENT'
]), 'END:VCALENDAR'].join('\r\n');
const inDays = (days, hours = 0) => DateTime.utc().plus({ days, hours }).toFormat("yyyyLLdd'T'HHmmss'Z'");
const event = (uid, title, url) => ({ uid, title, url, start: inDays(2), end: inDays(2, 3) });

function memoryStore() {
  const map = new Map();
  return { get: k => map.get(k), set: (k, v) => map.set(k, v), all: () => [...map].map(([key, data]) => ({ key, data })) };
}

function service({ send }) {
  const eventThreads = memoryStore();
  const svc = createEventThreadService({
    eventThreads,
    messages: { all: () => [] },
    access: createAccess({ settings: memoryStore(), env: { EVENT_THREAD_ROLE_IDS: 'events-team' } }),
    sendAuditLog: async () => {},
    getLogChannel: async () => ({ id: 'log', send }),
    getBookingChannel: async () => null,
    fetchDiscordChannel: async () => null
  });
  return { svc, eventThreads };
}

test('event links are kept only for plain https links on vatnz.net', t => {
  t.mock.method(console, 'log', () => {});
  const cases = [
    ['https://www.vatnz.net/events/123', 'https://www.vatnz.net/events/123'],
    ['https://evil.example.com/events', null],
    ['http://www.vatnz.net/events/123', null],
    ['https://www.vatnz.net/a) [x](https://evil.example.com)', null],
    ['www.vatnz.net/events/123', 'https://www.vatnz.net/events/123'], // live feed format
    ['evil.example.com/events', null],
    ['javascript:alert(1)', null],
    ['https://vatnz.net.evil.example.com/', null]
  ];
  for (const [url, expected] of cases) {
    const [parsed] = parseVatnzIcsEvents(ics([event('uid', 'Fly-in', url)]));
    const link = buildEventEmbed(parsed).toJSON().fields.find(f => f.name === 'Link');
    assert.equal(link?.value ?? null, expected && `[Open event](${expected})`, url);
  }
  // A link already saved in event state is checked again when posted.
  assert.equal(buildEventEmbed({ title: 'Old', url: 'https://evil.example.com', startUtcISO: '2026-12-20T06:00:00Z', endUtcISO: '2026-12-20T09:00:00Z' }).toJSON().fields.some(f => f.name === 'Link'), false);
});

test('long event IDs still work with the Create thread and Decline buttons', async () => {
  const sent = [];
  const { svc, eventThreads } = service({ send: async payload => { sent.push(payload); return { id: 'prompt' }; } });
  const uid = `${'x'.repeat(110)}@www.vatnz.net`;
  const [eventData] = parseVatnzIcsEvents(ics([event(uid, 'Long ID Fly-in')]));
  await svc.postEventThreadPrompt(eventData);

  const buttons = sent[0].components[0].toJSON().components;
  assert.ok(buttons.every(b => b.custom_id.length <= 100));

  let reply;
  await svc.handleEventThreadButton({
    member: { id: 'erin', roles: { cache: new Set(['events-team']) } }, user: { id: 'erin' },
    customId: buttons[1].custom_id, message: { edit: async () => {} },
    reply: async payload => { reply = payload; }
  });
  assert.match(reply.content, /Declined event thread for Long ID Fly-in/);
  assert.equal(eventThreads.all()[0].data.status, 'declined');
});

test('prompts posted before button IDs were hashed still work', async () => {
  const { svc, eventThreads } = service({ send: async () => ({ id: 'prompt' }) });
  await svc.postEventThreadPrompt(parseVatnzIcsEvents(ics([event('old-uid', 'Old Prompt')]))[0]);
  let reply;
  await svc.handleEventThreadButton({
    member: { id: 'erin', roles: { cache: new Set(['events-team']) } }, user: { id: 'erin' },
    customId: 'event_thread_decline:old-uid', message: { edit: async () => {} },
    reply: async payload => { reply = payload; }
  });
  assert.match(reply.content, /Declined event thread for Old Prompt/);
  assert.equal(eventThreads.all()[0].data.status, 'declined');
});

test('one bad event is skipped and logged, and the others are still processed', async t => {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  const titles = [];
  const { svc } = service({
    send: async payload => {
      const title = payload.embeds[0].toJSON().fields[0].value;
      if (title === 'Broken Event') throw new Error('Discord rejected the post');
      titles.push(title);
      return { id: 'prompt' };
    }
  });
  calendar = ics([event('broken', 'Broken Event'), { ...event('good', 'Auckland Arrivals'), start: inDays(3), end: inDays(3, 3) }]);
  await svc.checkVatnzEventThreads();

  assert.deepEqual(titles, ['Auckland Arrivals']);
  const skipped = lines.map(l => JSON.parse(l)).find(l => l.event === 'calendar_event_skipped');
  assert.equal(skipped.uid, 'broken');
  assert.match(skipped.error.message, /Discord rejected the post/);
});

test('long event titles are trimmed to fit Discord limits', () => {
  const { svc } = service({ send: async () => ({}) });
  const eventData = { uid: 'u', title: 'T'.repeat(400), startUtcISO: '2026-12-20T06:00:00Z', endUtcISO: '2026-12-20T09:00:00Z', categories: ['C'.repeat(1100)] };
  assert.ok(svc.buildEventCoverageEmbed(eventData).toJSON().title.length <= 256);
  const fields = buildEventEmbed(eventData).toJSON().fields;
  assert.ok(fields.every(f => f.value.length <= 1024));
});

test('expired thread cleanup recovers a false deletion and retries Discord failures', async () => {
  const eventThreads = memoryStore();
  const event = { uid: 'old', title: 'Fly-in', startUtcISO: '2020-01-01T01:00:00Z', endUtcISO: '2020-01-01T02:00:00Z' };
  eventThreads.set('old', { event, threadId: 'thread', status: 'deleted', deletedAt: event.endUtcISO,
    deleteNote: 'Thread was not found; treating it as already deleted.' });
  pruneEventRecords(eventThreads);
  const audit = [];
  let canFetch = false;
  let canDelete = false;
  let deletions = 0;
  const rest = {
    get: async route => {
      assert.equal(route, '/channels/thread');
      if (!canFetch) throw new Error('Missing Access');
      return { type: 11, parent_id: 'booking', thread_metadata: { archived: true } };
    },
    delete: async route => {
      assert.equal(route, '/channels/thread');
      if (!canDelete) throw new Error('Missing Permissions');
      deletions++;
    }
  };
  const svc = createEventThreadService({
    eventThreads, ...createDiscordHelpers({ client: { rest } }), sendAuditLog: entry => audit.push(entry)
  });
  for (const error of ['Missing Access', 'Missing Permissions']) {
    await svc.cleanupFinishedEventThreads();
    const state = eventThreads.get('old');
    assert.equal(state.status, 'delete_failed');
    assert.equal(state.deletedAt, undefined);
    assert.equal(state.deleteError, error);
    assert.equal(audit.at(-1).action, 'Event Thread Delete Failed');
    assert.ok(audit.at(-1).reason.includes(error));
    canFetch = true;
  }
  canDelete = true;
  await svc.cleanupFinishedEventThreads();
  await svc.cleanupFinishedEventThreads();
  assert.equal(deletions, 1);
  assert.equal(audit.length, 3);
  assert.equal(audit.at(-1).action, 'Event Thread Deleted');
  assert.equal(eventThreads.get('old').status, 'deleted');
  assert.ok(eventThreads.get('old').deletedAt);
  assert.equal(eventThreads.get('old').deleteError, undefined);
  assert.equal(eventThreads.get('old').deleteNote, undefined);
});

test('Unknown Channel during deletion records that the thread was already gone', async () => {
  const eventThreads = memoryStore();
  const event = { uid: 'gone', title: 'Fly-in', startUtcISO: '2020-01-01T01:00:00Z', endUtcISO: '2020-01-01T02:00:00Z' };
  eventThreads.set('gone', { event, threadId: 'thread', status: 'created' });
  const audit = [];
  const svc = createEventThreadService({
    eventThreads,
    deleteEventThread: async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); },
    sendAuditLog: entry => audit.push(entry.action)
  });
  await svc.cleanupFinishedEventThreads();
  await svc.cleanupFinishedEventThreads();
  assert.equal(eventThreads.get('gone').status, 'deleted');
  assert.deepEqual(audit, ['Event Thread Already Gone']);
});

test('a thread remains scheduled for deletion when its first post fails', async () => {
  const eventThreads = memoryStore();
  const event = { uid: 'failed-post', title: 'Fly-in', startUtcISO: '2020-01-01T01:00:00Z', endUtcISO: '2020-01-01T02:00:00Z' };
  let creates = 0;
  const deleted = [];
  const svc = createEventThreadService({
    eventThreads, sendAuditLog: async () => {},
    getBookingChannel: async () => ({ id: 'booking', threads: { create: async () => {
      creates++;
      return { id: 'thread', send: async () => { throw new Error('Post failed'); } };
    } } }),
    deleteEventThread: async (id, parent) => deleted.push([id, parent])
  });
  const first = svc.createEventThreadForEvent(event);
  const second = svc.createEventThreadForEvent(event);
  await Promise.all([assert.rejects(first, /Post failed/), assert.rejects(second, /Post failed/)]);
  assert.equal(creates, 1);
  await svc.cleanupFinishedEventThreads();
  assert.deepEqual(deleted, [['thread', 'booking']]);
});
