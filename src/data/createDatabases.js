const fs = require('fs');
const path = require('path');
const Database = require('easy-json-database');

function createDatabases(projectRoot) {
  const dbDirectory = path.join(projectRoot, 'db');
  fs.mkdirSync(dbDirectory, { recursive: true });

  const filenames = {
    event: 'event.json',
    messages: 'messages.json',
    eventclose: 'eventclose.json',
    eventThreads: 'eventthreads.json',
    endorsementWarnings: 'endorsementwarnings.json',
    settings: 'settings.json'
  };
  const dbPaths = {};
  const databases = {};

  for (const [name, filename] of Object.entries(filenames)) {
    const filePath = path.join(dbDirectory, filename);
    const legacyPath = path.join(projectRoot, filename);
    if (!fs.existsSync(filePath)) {
      if (fs.existsSync(legacyPath)) {
        // Preserve the old file as a backup; an existing db file always wins.
        fs.copyFileSync(legacyPath, filePath, fs.constants.COPYFILE_EXCL);
      } else {
        fs.writeFileSync(filePath, '{}\n', { encoding: 'utf8', flag: 'wx' });
      }
    }
    dbPaths[name] = filePath;
    databases[name] = new Database(filePath);
  }

  return { ...databases, dbPaths };
}

module.exports = { createDatabases };
