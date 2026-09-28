import type { QueuedPost } from "../src/lib/storage/posts";

// postpilot:posts in memory, held as the JSON string Redis would hold. It answers both
// the plain get/set a key-value store offers and the raw read and compare-and-set the
// post store writes through. `beforeWrite` runs once, just before the next write lands,
// to stand in for another request writing concurrently.
export function memoryPostStore(initial: QueuedPost[] = []) {
  let raw: string | null = initial.length ? JSON.stringify(initial) : null;
  let beforeWrite: (() => Promise<void>) | undefined;
  const concurrentWrite = async () => {
    const pending = beforeWrite;
    beforeWrite = undefined;
    await pending?.();
  };
  const store = {
    getRaw: async () => raw,
    compareAndSet: async (_key: string, expected: string, next: string) => {
      await concurrentWrite();
      if ((raw ?? "") !== expected) return false;
      raw = next;
      return true;
    },
    get: async <T,>() => (raw === null ? null : JSON.parse(raw) as T),
    set: async (_key: string, value: unknown) => {
      await concurrentWrite();
      raw = JSON.stringify(value);
      return "OK";
    },
  };
  return {
    store,
    read: () => (raw === null ? [] : JSON.parse(raw) as QueuedPost[]),
    onNextWrite: (write: () => Promise<void>) => { beforeWrite = write; },
    // Makes every write fail its compare-and-set, as if another writer always got there first.
    alwaysConflict: () => { store.compareAndSet = async () => false; },
  };
}
