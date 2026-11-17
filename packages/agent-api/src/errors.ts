/**
 * Why a tool call was refused. Every code is a stable string an agent can
 * branch on; the message is for the person reading the agent's transcript.
 */
export type AgentToolErrorCode =
  /** The server was not granted the scope this tool needs. */
  | 'scope'
  /** A rate limit was reached; retry after `retryAfterMs`. */
  | 'rate_limited'
  /** A kernel job is running and another is already waiting. */
  | 'busy'
  /** The exact derivation ran past its time budget. */
  | 'timeout'
  /** No granted project has that alias or id. */
  | 'not_found'
  /** The project changed since the version the call was planned against. */
  | 'conflict'
  /** The arguments or the proposal failed validation. */
  | 'invalid'
  /** The exact kernel or the command system refused the change. */
  | 'refused'
  /** A response or input exceeded its size budget. */
  | 'too_large';

export class AgentToolError extends Error {
  constructor(
    readonly code: AgentToolErrorCode,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'AgentToolError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The request failed.';
}
