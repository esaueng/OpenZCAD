/**
 * The content-addressed source blob store, exercised against a fake IndexedDB
 * that keeps the two properties this code depends on: transactions over a store
 * are serialised, and a transaction commits once its requests are done and
 * control returns to the event loop.
 *
 * Requests therefore settle on the event loop rather than the microtask queue —
 * the point of the fake is that another caller gets to run between them, which
 * is what a real database does and what a microtask-only fake would hide.
 *
 * What is under test is `created`. It is the whole licence an import has to
 * delete source bytes again — the store is device-global, so a key it did not
 * create may be backing a project that is not even open — and answering it
 * needs the existence check and the write to be ONE transaction. Split across
 * two, both importers of the same file are told they created the record.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface FakeRecord {
  checksumSha256: string;
  body: Blob;
  logicalBytes: number;
  createdAt: string;
}

class FakeRequest<T> {
  result!: T;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

/** One object store's records. */
class FakeStoreData {
  readonly records = new Map<string, FakeRecord>();
}

class FakeObjectStore {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly data: FakeStoreData
  ) {}

  count(key: string): FakeRequest<number> {
    return this.tx.enqueue(() => (this.data.records.has(key) ? 1 : 0));
  }

  get(key: string): FakeRequest<FakeRecord | undefined> {
    return this.tx.enqueue(() => this.data.records.get(key));
  }

  getAllKeys(): FakeRequest<string[]> {
    return this.tx.enqueue(() => [...this.data.records.keys()]);
  }

  put(record: FakeRecord): FakeRequest<string> {
    return this.tx.enqueue(() => {
      this.data.records.set(record.checksumSha256, record);
      return record.checksumSha256;
    });
  }

  delete(key: string): FakeRequest<undefined> {
    return this.tx.enqueue(() => {
      this.data.records.delete(key);
      return undefined;
    });
  }
}

class FakeTransaction {
  error: unknown = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private readonly queued: Array<() => void> = [];
  private pending = 0;
  private active = false;
  private finished = false;

  constructor(
    private readonly database: FakeDatabase,
    readonly storeNames: readonly string[]
  ) {
    this.database.schedule(this);
  }

  objectStore(name: string): FakeObjectStore {
    if (!this.storeNames.includes(name)) {
      throw new Error(`Store ${name} is outside this transaction.`);
    }
    return new FakeObjectStore(this, this.database.storeData(name));
  }

  enqueue<T>(action: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.pending += 1;
    const task = () => {
      request.result = action();
      request.onsuccess?.();
      this.pending -= 1;
      // One turn later: a continuation resumed by `onsuccess` gets to issue its
      // next request first, and that request joins this transaction — which is
      // exactly what makes read-then-write atomic. A caller that awaits
      // anything else instead loses the transaction, as it would in a browser.
      queueMicrotask(() => this.settle());
    };
    if (this.active) {
      setTimeout(task, 0);
    } else {
      this.queued.push(task);
    }
    return request;
  }

  /** Called by the database when this transaction reaches the head of its queue. */
  start(): void {
    this.active = true;
    for (const task of this.queued.splice(0)) {
      setTimeout(task, 0);
    }
    queueMicrotask(() => this.settle());
  }

  abort(): void {
    if (this.finished) {
      throw new Error('Transaction has already finished.');
    }
    this.finished = true;
    this.onabort?.();
    this.database.finish(this);
  }

  private settle(): void {
    if (this.finished || !this.active || this.pending > 0) {
      return;
    }
    this.finished = true;
    this.oncomplete?.();
    this.database.finish(this);
  }
}

/**
 * The backing store is shared by every connection, as it is in a browser: the
 * app opens and closes a connection per transaction, so serialisation cannot
 * live in the connection.
 */
class FakeDatabase {
  private readonly stores = new Map<string, FakeStoreData>();
  private readonly queue: FakeTransaction[] = [];

  storeData(name: string): FakeStoreData {
    let data = this.stores.get(name);
    if (!data) {
      data = new FakeStoreData();
      this.stores.set(name, data);
    }
    return data;
  }

  records(name: string): Map<string, FakeRecord> {
    return this.storeData(name).records;
  }

  clear(): void {
    this.stores.clear();
  }

  schedule(tx: FakeTransaction): void {
    this.queue.push(tx);
    if (this.queue.length === 1) {
      setTimeout(() => tx.start(), 0);
    }
  }

  finish(tx: FakeTransaction): void {
    const index = this.queue.indexOf(tx);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
    const next = this.queue[0];
    if (next) {
      setTimeout(() => next.start(), 0);
    }
  }
}

const database = new FakeDatabase();

const connection = {
  objectStoreNames: { contains: () => true },
  createObjectStore: () => undefined,
  transaction: (storeNames: string | string[]) =>
    new FakeTransaction(
      database,
      typeof storeNames === 'string' ? [storeNames] : storeNames
    ),
  close: () => undefined
};

(globalThis as { indexedDB?: unknown }).indexedDB = {
  open: () => {
    const request = new FakeRequest<typeof connection>();
    request.result = connection;
    setTimeout(() => request.onsuccess?.(), 0);
    return request;
  }
};

const {
  putSourceBlobIfAbsent,
  hasSourceBlob,
  loadSourceBlob,
  deleteSourceBlob
} = await import('../apps/web/src/lib/localProjectStore');

const BLOB_STORE = 'sourceBlobs';

function sourceBytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

describe('source blob store', () => {
  beforeEach(() => {
    database.clear();
  });
  afterEach(() => {
    database.clear();
  });

  it('tells exactly one of two simultaneous writers that it created the record', async () => {
    // Two imports of the same file, started before either finished — the
    // second copy of a drag-and-drop, or two tabs. Whoever is told `created`
    // believes the key is theirs to delete again, so telling both is how a
    // refusal on one side destroys the source the other one committed against.
    const bytes = sourceBytes('ISO-10303-21; /* one file, two importers */');
    const [first, second] = await Promise.all([
      putSourceBlobIfAbsent(bytes),
      putSourceBlobIfAbsent(bytes)
    ]);

    expect(second.ref.checksumSha256).toBe(first.ref.checksumSha256);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(database.records(BLOB_STORE).size).toBe(1);
  });

  it('reports the second write of the same bytes as not created, and leaves the record alone', async () => {
    const bytes = sourceBytes('ISO-10303-21; /* imported twice */');
    const first = await putSourceBlobIfAbsent(bytes);
    expect(first.created).toBe(true);
    const stored = database.records(BLOB_STORE).get(first.ref.checksumSha256);
    expect(stored).toBeDefined();

    const second = await putSourceBlobIfAbsent(bytes);
    expect(second.created).toBe(false);
    // The store is content-addressed: the record there already holds these very
    // bytes, so rewriting it would copy up to 250 MB to change nothing.
    expect(database.records(BLOB_STORE).get(first.ref.checksumSha256)).toBe(
      stored
    );
  });

  it('round-trips the bytes it stored and removes exactly one key', async () => {
    const frame = sourceBytes('ISO-10303-21; /* frame */');
    const plate = sourceBytes('ISO-10303-21; /* plate */');
    const storedFrame = await putSourceBlobIfAbsent(frame);
    const storedPlate = await putSourceBlobIfAbsent(plate);

    expect(await loadSourceBlob(storedFrame.ref.checksumSha256)).toEqual(frame);
    expect(await hasSourceBlob(storedPlate.ref.checksumSha256)).toBe(true);

    await deleteSourceBlob(storedFrame.ref.checksumSha256);
    expect(await hasSourceBlob(storedFrame.ref.checksumSha256)).toBe(false);
    expect(await loadSourceBlob(storedFrame.ref.checksumSha256)).toBeNull();
    expect(await hasSourceBlob(storedPlate.ref.checksumSha256)).toBe(true);
  });
});
