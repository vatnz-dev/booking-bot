// One queue for every change to bookings, from users and background tasks alike,
// so no change reads a list that another is about to overwrite.
let tail = Promise.resolve();

function runBookingMutation(action) {
  const next = tail.then(action);
  tail = next.catch(() => {});
  return next;
}

module.exports = { runBookingMutation };
