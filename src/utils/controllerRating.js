const { ratingRoleIds, ratingLabels, RATING_PRIORITY } = require('../constants');

function getControllerTier(member) {
  for (const rating of RATING_PRIORITY) {
    const id = ratingRoleIds[rating];
    if (id && member?.roles?.cache?.has(id)) return rating;
  }
  return 'UNRATED';
}

function getControllerRatingLabel(member) {
  return ratingLabels[getControllerTier(member)] || null;
}

module.exports = { getControllerTier, getControllerRatingLabel };
