export class DurableObject {
  constructor(_ctx: unknown, _env: unknown) {}
}

export class WorkflowEntrypoint<TEnv = unknown, TPayload = unknown> {
  env: TEnv;

  constructor(_ctx: unknown, env: TEnv) {
    this.env = env;
  }

  run(_event: WorkflowEvent<TPayload>, _step: WorkflowStep): Promise<unknown> {
    return Promise.resolve(undefined);
  }
}

export interface WorkflowEvent<TPayload = unknown> {
  payload: TPayload;
}

export interface WorkflowStep {
  do<T>(_name: string, callback: () => Promise<T> | T): Promise<T>;
}
