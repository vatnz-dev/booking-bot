function needsThreadCleanup(state) {
  if (!state?.event || !state.threadId) return false;
  return state.status === 'created' || state.status === 'delete_failed'
    || (state.status === 'deleted' && state.deleteNote === 'Thread was not found; treating it as already deleted.');
}

module.exports = { needsThreadCleanup };
