const { log, logFailures } = require('../utils/log');

// Records are kept this long after their event ends or endorsement expires; audit.jsonl keeps the history.
const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function pruneEventRecords(eventThreads, now = Date.now()) {
  for (const { key, data } of eventThreads.all()) {
    const endedAt = Date.parse(data?.event?.endUtcISO || '');
    if (!endedAt || now - endedAt <= RETENTION_DAYS * DAY_MS) continue;
    eventThreads.delete(key);
    log('info', 'event_record_pruned', { uid: data.event.uid, title: data.event.title, status: data.status, endedAt: data.event.endUtcISO });
  }
}

// Warning keys end with the endorsement's expiry date and the days-before value (see endorsementWarningKey).
function pruneEndorsementWarnings(endorsementWarnings, now = Date.now()) {
  for (const { key } of endorsementWarnings.all()) {
    const expiry = Date.parse(String(key).split(':').at(-2) || '');
    if (!expiry || now - expiry <= RETENTION_DAYS * DAY_MS) continue;
    endorsementWarnings.delete(key);
    log('info', 'endorsement_warning_pruned', { key });
  }
}

function startHousekeepingScheduler({ eventThreads, endorsementWarnings }) {
  const run = logFailures('housekeeping', {}, () => {
    pruneEventRecords(eventThreads);
    pruneEndorsementWarnings(endorsementWarnings);
  });
  run();
  setInterval(run, DAY_MS);
}

module.exports = { RETENTION_DAYS, pruneEventRecords, pruneEndorsementWarnings, startHousekeepingScheduler };
