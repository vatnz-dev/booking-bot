// Share one queue between every service that writes booking records.
function createBookingMutationQueue() {
  let pending = Promise.resolve();
  return action => {
    const next = pending.then(action);
    pending = next.catch(() => {});
    return next;
  };
}
module.exports = { createBookingMutationQueue };
