/** Run writes in submission order. A failed write must not poison later work. */
export function createSerialQueue() {
  let tail: Promise<void> = Promise.resolve();
  return function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
