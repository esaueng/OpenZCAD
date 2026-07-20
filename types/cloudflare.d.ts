declare class DurableObject {
  constructor(ctx: unknown, env: unknown);
}


declare interface DurableObjectNamespace<T = unknown> {
  getByName(name: string): T;
}

declare interface D1RunResult {
  success?: boolean;
  meta?: {
    changes?: number;
  };
}

declare interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1RunResult>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
}

declare interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1RunResult[]>;
}

declare interface R2Object {
  size: number;
}

declare interface R2ObjectBody extends R2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
}

declare interface R2Bucket {
  put(
    key: string,
    value: ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<R2Object>;
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
}

declare interface Queue<T = unknown> {
  send(message: T): Promise<void>;
}

declare interface WebSocket {
  accept(): void;
}

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: WebSocket };
};

declare interface ResponseInit {
  webSocket?: WebSocket;
}

declare module 'cloudflare:workers' {
  export class DurableObject {
    constructor(ctx: unknown, env: unknown);
  }

}
