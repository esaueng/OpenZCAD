/**
 * Request/response protocol between the page and the MLS Worker. Requests
 * are answered in order; byte arrays and CryptoKeys travel by structured
 * clone (a non-extractable key stays non-extractable).
 */
import type { AsyncEngineApi, EngineMethod, MlsEngine } from './engine';
import { MlsError, serializeError } from './errors';

export interface Request {
  id: number;
  method: EngineMethod;
  args: unknown[];
}

export type Response =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: ReturnType<typeof serializeError> };

/** The part of a Worker or MessagePort the protocol uses. */
export interface Port {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void
  ): void;
}

const METHODS = new Set<string>([
  'buildInfo',
  'leafCertificationPayload',
  'decodeEpochRecord',
  'verifyEpochAuthority',
  'generate',
  'open',
  'seal',
  'free',
  'signatureKey',
  'certificationPayload',
  'certify',
  'setDirectory',
  'createGroup',
  'keyPackage',
  'inspectWelcome',
  'join',
  'beginJoin',
  'completeJoin',
  'discardJoin',
  'archiveKey',
  'commit',
  'confirmCommit',
  'discardCommit',
  'proposeAdd',
  'proposeUpdate',
  'proposeSelfRemove',
  'process',
  'groupInfo',
  'inspectGroupInfo',
  'rejoin',
  'beginRejoin',
  'completeRejoin',
  'confirmRejoin',
  'discardRejoin',
  'status',
  'projectKey',
  'epochAuthenticator',
  'rejoinPsk',
  'insecureSkipSendChecksForTests'
] satisfies EngineMethod[]);

/** Serve an engine on a port, one request at a time. */
export function serveEngine(port: Port, ready: Promise<MlsEngine>): void {
  let queue: Promise<void> = Promise.resolve();
  port.addEventListener('message', (event: MessageEvent) => {
    const request = event.data as Request;
    queue = queue.then(async () => {
      let response: Response;
      try {
        if (!METHODS.has(request.method)) {
          throw new MlsError(
            'input',
            `unknown method ${String(request.method)}`
          );
        }
        const engine = await ready;
        const fn = (
          engine as unknown as Record<string, (...args: unknown[]) => unknown>
        )[request.method];
        const value = await fn!.apply(engine, request.args);
        response = { id: request.id, ok: true, value };
      } catch (error) {
        response = { id: request.id, ok: false, error: serializeError(error) };
      }
      port.postMessage(response);
    });
  });
}

export interface EngineConnection {
  api: AsyncEngineApi;
  /** Reject every pending and later request, e.g. when the Worker dies. */
  fail(reason: string): void;
}

/** A client for an engine served on `port`. */
export function connectEngine(port: Port): EngineConnection {
  let nextId = 1;
  let failure: MlsError | null = null;
  const waiting = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  port.addEventListener('message', (event: MessageEvent) => {
    const response = event.data as Response;
    const entry = waiting.get(response.id);
    if (!entry) return;
    waiting.delete(response.id);
    if (response.ok) entry.resolve(response.value);
    else
      entry.reject(
        new MlsError(
          response.error.kind,
          response.error.message,
          response.error.reasons
        )
      );
  });
  const api = new Proxy({} as AsyncEngineApi, {
    get(_, method: string) {
      if (!METHODS.has(method)) return undefined;
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          if (failure) {
            reject(failure);
            return;
          }
          const id = nextId++;
          waiting.set(id, { resolve, reject });
          port.postMessage({
            id,
            method: method as EngineMethod,
            args
          } satisfies Request);
        });
    }
  });
  return {
    api,
    fail(reason) {
      failure ??= new MlsError('worker', reason);
      for (const entry of waiting.values()) entry.reject(failure);
      waiting.clear();
    }
  };
}
