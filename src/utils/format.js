function cleanEmbedValue(value, fallback = 'N/A') {
  const text = value === undefined || value === null || value === '' ? fallback : String(value);
  return text.length > 1024 ? `${text.slice(0, 1021)}...` : text;
}

module.exports = {
  cleanEmbedValue
};
