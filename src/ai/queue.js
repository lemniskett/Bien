/**
 * Per-key serial queue. Ensures only one task runs at a time for a given key
 * (we key by channel/session so concurrent messages or a scheduled fire can't
 * invoke the same AI session simultaneously).
 */
const chains = new Map();

export function enqueue(key, task) {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(task, task); // run regardless of previous outcome
  // keep the chain alive but swallow errors so one failure doesn't poison the key
  chains.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}
