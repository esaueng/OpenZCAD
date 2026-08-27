import type { CollaborationServerMessage } from '@openzcad/shared';

/**
 * Fake Durable Object storage: one flat key/value map with the batch `put` and
 * array `delete` overloads the room relies on. Values are cloned on write so a
 * test cannot observe a mutation the room never persisted.
 */
export interface FakeRoomStorage {
  values: Map<string, unknown>;
  context: {
    storage: {
      get<T>(key: string): Promise<T | undefined>;
      put(keyOrEntries: unknown, value?: unknown): Promise<void>;
      delete(keyOrKeys: string | string[]): Promise<boolean | number>;
      deleteAll(): Promise<void>;
    };
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  };
}

export function createRoomContext(
  values = new Map<string, unknown>()
): FakeRoomStorage {
  return {
    values,
    context: {
      storage: {
        async get<T>(key: string) {
          return values.get(key) as T | undefined;
        },
        async put(keyOrEntries: unknown, value?: unknown) {
          if (typeof keyOrEntries === 'string') {
            values.set(keyOrEntries, structuredClone(value));
            return;
          }
          for (const [key, entry] of Object.entries(
            keyOrEntries as Record<string, unknown>
          )) {
            values.set(key, structuredClone(entry));
          }
        },
        async delete(keyOrKeys: string | string[]) {
          if (!Array.isArray(keyOrKeys)) {
            return values.delete(keyOrKeys);
          }
          let deleted = 0;
          for (const key of keyOrKeys) {
            if (values.delete(key)) {
              deleted += 1;
            }
          }
          return deleted;
        },
        async deleteAll() {
          values.clear();
        }
      },
      async blockConcurrencyWhile<T>(callback: () => Promise<T>) {
        return callback();
      }
    }
  };
}

/**
 * Awaits the room's constructor-time load. Outside Workers there is no real
 * `blockConcurrencyWhile`, so the load only becomes observable through `fetch`,
 * which every request path already gates on it. A bare GET is the cheapest
 * probe: it settles the load and answers 426 without touching room state.
 */
export async function settleRoom(room: {
  fetch(request: Request): Promise<Response>;
}): Promise<void> {
  await room.fetch(new Request('https://room.test/'));
}

/** Serialized size of every stored value, keyed the same as storage. */
export function storedValueBytes(values: Map<string, unknown>): Map<
  string,
  number
> {
  const encoder = new TextEncoder();
  return new Map(
    Array.from(values, ([key, value]) => [
      key,
      encoder.encode(JSON.stringify(value)).byteLength
    ])
  );
}

/**
 * Minimal stand-in for a Workers WebSocket. Records what the room sent and
 * whether it closed the socket, so a test can assert the room answered a bad
 * message *and* left the connection usable.
 */
export class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState: number = FakeWebSocket.OPEN;
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  private readonly listeners = new Map<
    string,
    Array<(event: unknown) => void>
  >();

  accept(): void {}

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
  }

  /**
   * Delivers a frame and waits a macrotask. The room's message listener is
   * fire-and-forget, so the assertions have to run after its promise chain
   * settles rather than after `dispatch` returns.
   */
  async receive(data: string): Promise<void> {
    for (const handler of this.listeners.get('message') ?? []) {
      handler({ data });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  frames(): CollaborationServerMessage[] {
    return this.sent.map(
      (frame) => JSON.parse(frame) as CollaborationServerMessage
    );
  }

  lastFrame(): CollaborationServerMessage | undefined {
    return this.frames().at(-1);
  }
}

interface WorkerGlobals {
  WebSocketPair?: unknown;
  WebSocket?: unknown;
  Response?: unknown;
}

/**
 * Installs the Workers globals the room's upgrade path needs. `Response`
 * refuses status 101 outside Workers, so the shim reports 101 over a body-less
 * response and carries the socket the room handed back.
 */
export function installWorkerSocketGlobals(): {
  serverSockets: FakeWebSocket[];
  restore(): void;
} {
  const globals = globalThis as WorkerGlobals;
  const original = {
    WebSocketPair: globals.WebSocketPair,
    WebSocket: globals.WebSocket,
    Response: globals.Response
  };
  const NativeResponse = globalThis.Response;
  const serverSockets: FakeWebSocket[] = [];

  class UpgradeResponse extends NativeResponse {
    override webSocket?: WebSocket | null;

    constructor(body?: BodyInit | null, init?: ResponseInit) {
      const status = init?.status;
      if (status === 101) {
        super(null, { ...init, status: 200 });
        Object.defineProperty(this, 'status', { value: 101 });
        this.webSocket = (init as { webSocket?: WebSocket | null }).webSocket;
        return;
      }
      super(body, init);
    }
  }

  globals.WebSocketPair = function WebSocketPair() {
    const client = new FakeWebSocket();
    const server = new FakeWebSocket();
    serverSockets.push(server);
    return [client, server];
  };
  globals.WebSocket = FakeWebSocket;
  globals.Response = UpgradeResponse;

  return {
    serverSockets,
    restore() {
      globals.WebSocketPair = original.WebSocketPair;
      globals.WebSocket = original.WebSocket;
      globals.Response = original.Response;
    }
  };
}
