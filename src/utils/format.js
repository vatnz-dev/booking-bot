function cleanEmbedValue(value, fallback = 'N/A') {
  const text = value === undefined || value === null || value === '' ? fallback : String(value);
  return text.length > 1024 ? `${text.slice(0, 1021)}...` : text;
}

function summarizeError(err) {
  if (!err) return 'Unknown error';
  const code = err.code || err.cause?.code;
  const status = err.response?.status ? `HTTP ${err.response.status}` : null;
  const url = err.config?.url;
  const message = err.message || err.cause?.message || String(err);
  return [code, status, message, url].filter(Boolean).join(' - ');
}

module.exports = {
  cleanEmbedValue,
  summarizeError
};
