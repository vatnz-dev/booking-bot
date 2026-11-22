function needsThreadCleanup(state) {
  if (!state?.event || !state.threadId) return false;
  return ['created', 'delete_failed', 'prompted', 'declined'].includes(state.status)
    || (state.status === 'deleted' && state.deleteNote === 'Thread was not found; treating it as already deleted.');
}

module.exports = { needsThreadCleanup };
