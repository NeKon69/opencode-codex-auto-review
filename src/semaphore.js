export function createSemaphore(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");

  let active = 0;
  const waiters = [];

  function abortError() {
    const error = new Error("review wait aborted");
    error.name = "AbortError";
    return error;
  }

  function releaseFactory() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      dispatch();
    };
  }

  function dispatch() {
    while (active < limit && waiters.length > 0) {
      const waiter = waiters.shift();
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      active++;
      waiter.resolve(releaseFactory());
    }
  }

  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (active < limit) {
      active++;
      return Promise.resolve(releaseFactory());
    }

    return new Promise((resolve, reject) => {
      const waiter = { signal, resolve, reject, onAbort: undefined };
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index < 0) return;
        waiters.splice(index, 1);
        signal.removeEventListener("abort", waiter.onAbort);
        reject(abortError());
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      waiters.push(waiter);
      if (signal?.aborted) waiter.onAbort();
    });
  }

  return {
    acquire,
    get activeCount() {
      return active;
    },
    get queuedCount() {
      return waiters.length;
    },
  };
}
