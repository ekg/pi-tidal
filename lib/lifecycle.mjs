// Serialize boot, explicit restart and shutdown. A failed operation must not
// poison the queue or allow a second operation to overlap its cleanup.
export function createLifecycleQueue() {
  let tail = Promise.resolve();
  return function run(operation) {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
}
