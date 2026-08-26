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
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

declare interface R2UploadedPart {
  partNumber: number;
  etag: string;
}

declare interface R2MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(partNumber: number, value: ArrayBuffer): Promise<R2UploadedPart>;
  abort(): Promise<void>;
  complete(uploadedParts: R2UploadedPart[]): Promise<R2Object>;
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
  createMultipartUpload(
    key: string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
}

declare interface Queue<T = unknown> {
  send(message: T): Promise<void>;
}

// Minimal declarations copied from `wrangler types` for the native Email
// Service binding. Regenerate them when the Wrangler runtime version changes.
declare interface EmailAddress {
  name: string;
  email: string;
}

declare interface EmailSendResult {
  messageId: string;
}

declare interface EmailMessageBuilder {
  to: string | EmailAddress | (string | EmailAddress)[];
  from: string | EmailAddress;
  subject: string;
  replyTo?: string | EmailAddress;
  headers?: Record<string, string>;
  text?: string;
  html?: string;
}

declare interface SendEmail {
  send(message: EmailMessageBuilder): Promise<EmailSendResult>;
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

// Workers runtime extension: set on the 101 answer to a WebSocket upgrade.
declare interface Response {
  readonly webSocket?: WebSocket | null;
}

declare module 'cloudflare:workers' {
  export class DurableObject {
    constructor(ctx: unknown, env: unknown);
  }

}
