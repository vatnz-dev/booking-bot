const path = require('path');
const { createDatabases } = require('./createDatabases');

const projectRoot = path.resolve(__dirname, '..', '..');

module.exports = createDatabases(projectRoot);
