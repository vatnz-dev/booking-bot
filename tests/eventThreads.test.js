const { test } = require('node:test');
const assert = require('node:assert/strict');

let calendar = '';
require.cache[require.resolve('../src/utils/http')] = { loaded: true, exports: { get: async () => ({ data: calendar }) } };
const { DateTime } = require('luxon');
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
