const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabases } = require('../src/data/createDatabases');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-bot-db-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('all six databases are created under db and writes survive restart', t => {
  const root = temporaryRoot(t);
  const stores = createDatabases(root);
  assert.equal(Object.keys(stores.dbPaths).length, 6);
  for (const [name, filePath] of Object.entries(stores.dbPaths)) {
    assert.equal(path.dirname(filePath), path.join(root, 'db'));
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), {});
    stores[name].set('persisted', { value: name });
  }
  const restarted = createDatabases(root);
  for (const name of Object.keys(stores.dbPaths)) {
    assert.deepEqual(restarted[name].get('persisted'), { value: name });
  }
});

test('legacy files are copied without altering backups or overwriting db data on restart', t => {
  const root = temporaryRoot(t);
  const filenames = ['event.json', 'messages.json', 'eventclose.json', 'eventthreads.json', 'endorsementwarnings.json', 'settings.json'];
  for (const filename of filenames) {
    fs.writeFileSync(path.join(root, filename), JSON.stringify({ legacy: filename }));
  }
  const stores = createDatabases(root);
  for (const [name, filePath] of Object.entries(stores.dbPaths)) {
    const filename = path.basename(filePath);
    assert.equal(stores[name].get('legacy'), filename);
    stores[name].set('legacy', 'updated');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8')), { legacy: filename });
  }
  const restarted = createDatabases(root);
  for (const name of Object.keys(stores.dbPaths)) {
    assert.equal(restarted[name].get('legacy'), 'updated');
  }
});
