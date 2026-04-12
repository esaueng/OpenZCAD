declare class DurableObject {
  constructor(ctx: unknown, env: unknown);
}

declare class WorkflowEntrypoint<TEnv = unknown, TPayload = unknown> {
  env: TEnv;
  constructor(ctx: unknown, env: TEnv);
  run(event: WorkflowEvent<TPayload>, step: WorkflowStep): Promise<unknown>;
}

declare interface WorkflowEvent<TPayload = unknown> {
  payload: TPayload;
}

declare interface WorkflowStep {
  do<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
}

declare interface Workflow<TPayload = unknown> {
  create(input: { params: TPayload }): Promise<unknown>;
}

declare interface DurableObjectNamespace<T = unknown> {
  getByName(name: string): T;
}

declare interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
}

declare interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}

declare interface R2Bucket {}

declare interface Queue<T = unknown> {
  send(message: T): Promise<void>;
}

declare module 'cloudflare:workers' {
  export class DurableObject {
    constructor(ctx: unknown, env: unknown);
  }

  export class WorkflowEntrypoint<TEnv = unknown, TPayload = unknown> {
    env: TEnv;
    constructor(ctx: unknown, env: TEnv);
    run(event: WorkflowEvent<TPayload>, step: WorkflowStep): Promise<unknown>;
  }

  export type { WorkflowEvent, WorkflowStep };
}
