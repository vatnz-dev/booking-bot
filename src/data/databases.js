const fs = require('fs');
const path = require('path');
const Database = require('easy-json-database');

const projectRoot = path.resolve(__dirname, '..', '..');

const dbPaths = {
  event: path.join(projectRoot, 'event.json'),
  messages: path.join(projectRoot, 'messages.json'),
  eventclose: path.join(projectRoot, 'eventclose.json'),
  eventThreads: path.join(projectRoot, 'eventthreads.json'),
  endorsementWarnings: path.join(projectRoot, 'endorsementwarnings.json')
};

function ensureJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '{}\n', 'utf8');
  }
}

for (const filePath of Object.values(dbPaths)) {
  ensureJsonFile(filePath);
}

module.exports = {
  event: new Database(dbPaths.event),
  messages: new Database(dbPaths.messages),
  eventclose: new Database(dbPaths.eventclose),
  eventThreads: new Database(dbPaths.eventThreads),
  endorsementWarnings: new Database(dbPaths.endorsementWarnings),
  dbPaths
};
