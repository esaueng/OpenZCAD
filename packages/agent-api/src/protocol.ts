import { AGENT_TOOL_DEFINITIONS, type AgentApi } from './tools';

/**
 * The Model Context Protocol subset the agent API needs: `initialize`,
 * `notifications/initialized`, `ping`, `tools/list` and `tools/call`, as
 * JSON-RPC 2.0 messages, one per line. Hand-rolled on purpose (design note,
 * "Transport"): the surface is small, and it keeps the MCP SDK out of the
 * dependency tree.
 */

/** Newest first. The client's revision is echoed when it is one of these. */
export const MCP_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05'
] as const;

/** One request line is at most this many bytes of UTF-8 JSON. */
export const MAX_MCP_LINE_BYTES = 2 * 1024 * 1024;

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

type JsonRpcId = string | number;

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpSessionOptions {
  api: AgentApi;
  serverInfo: { name: string; version: string };
  instructions?: string;
  /** Diagnostics; never written to the protocol stream. */
  log?: (message: string) => void;
}

function failure(
  id: JsonRpcId | null,
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isId(value: unknown): value is JsonRpcId {
  return (
    (typeof value === 'string' && value.length <= 200) ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  );
}

/** One client connection's protocol state. */
export class McpSession {
  private initialized = false;
  protocolVersion: string | null = null;

  constructor(private readonly options: McpSessionOptions) {}

  /** Answers one decoded message; null for a notification. */
  async handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (!message || typeof message !== 'object' || Array.isArray(message))
      return failure(
        null,
        JSON_RPC_INVALID_REQUEST,
        'Expected one JSON-RPC 2.0 message object (batches are not supported).'
      );
    const request = message as Record<string, unknown>;
    const hasId = Object.hasOwn(request, 'id');
    if (
      request.jsonrpc !== '2.0' ||
      typeof request.method !== 'string' ||
      (hasId && !isId(request.id))
    )
      return failure(
        hasId && isId(request.id) ? request.id : null,
        JSON_RPC_INVALID_REQUEST,
        'Invalid JSON-RPC 2.0 request.'
      );
    const method = request.method;
    const params = request.params;
    if (!hasId) {
      if (method === 'notifications/initialized' && this.protocolVersion)
        this.initialized = true;
      // Cancellation and other notifications need no answer; a running
      // kernel job is bounded by its own time budget.
      return null;
    }
    const id = request.id as JsonRpcId;
    try {
      if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (method === 'initialize') return this.initialize(id, params);
      if (!this.protocolVersion)
        return failure(
          id,
          JSON_RPC_INVALID_REQUEST,
          'The session is not initialized. Send initialize first.'
        );
      // Some clients send the next request before `initialized` arrives;
      // a completed `initialize` is enough to serve tools.
      if (method === 'tools/list')
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: this.options.api.tools().map((tool) => ({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              inputSchema: tool.inputSchema,
              annotations: { title: tool.title, ...tool.annotations }
            }))
          }
        };
      if (method === 'tools/call') return await this.callTool(id, params);
      return failure(
        id,
        JSON_RPC_METHOD_NOT_FOUND,
        `Method not found: ${method.slice(0, 100)}`
      );
    } catch (error) {
      this.options.log?.(
        `internal error in ${method}: ${error instanceof Error ? error.stack : String(error)}`
      );
      return failure(id, JSON_RPC_INTERNAL_ERROR, 'Internal error.');
    }
  }

  get ready(): boolean {
    return this.initialized;
  }

  private initialize(id: JsonRpcId, params: unknown): JsonRpcResponse {
    const requested =
      params && typeof params === 'object'
        ? (params as Record<string, unknown>).protocolVersion
        : undefined;
    if (typeof requested !== 'string')
      return failure(
        id,
        JSON_RPC_INVALID_PARAMS,
        'initialize needs a protocolVersion.'
      );
    this.protocolVersion = (
      MCP_PROTOCOL_VERSIONS as readonly string[]
    ).includes(requested)
      ? requested
      : MCP_PROTOCOL_VERSIONS[0];
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: this.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: this.options.serverInfo,
        ...(this.options.instructions
          ? { instructions: this.options.instructions }
          : {})
      }
    };
  }

  private async callTool(
    id: JsonRpcId,
    params: unknown
  ): Promise<JsonRpcResponse> {
    if (!params || typeof params !== 'object' || Array.isArray(params))
      return failure(
        id,
        JSON_RPC_INVALID_PARAMS,
        'tools/call needs a name and arguments.'
      );
    const { name, arguments: args } = params as Record<string, unknown>;
    if (
      typeof name !== 'string' ||
      !this.options.api.tools().some((tool) => tool.name === name)
    ) {
      // A tool outside the granted scope is reported by the API as a scope
      // refusal, so the agent learns which grant it lacks.
      const known =
        typeof name === 'string' &&
        AGENT_TOOL_DEFINITIONS.some((tool) => tool.name === name);
      if (!known)
        return failure(
          id,
          JSON_RPC_INVALID_PARAMS,
          `Unknown tool: ${String(name).slice(0, 100)}`
        );
    }
    const result = await this.options.api.call(name, args);
    return { jsonrpc: '2.0', id, result };
  }
}

/**
 * Splits a byte stream into lines without letting one unterminated line
 * grow past `maxLineBytes`: an oversized line is reported once and skipped
 * through its newline.
 */
export class LineFramer {
  private buffer = '';
  private bufferBytes = 0;
  private discarding = false;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly maxLineBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onOversize: () => void
  ) {}

  push(chunk: Uint8Array | string): void {
    const text =
      typeof chunk === 'string'
        ? chunk
        : this.decoder.decode(chunk, { stream: true });
    let start = 0;
    for (;;) {
      const newline = text.indexOf('\n', start);
      const piece = text.slice(start, newline === -1 ? undefined : newline);
      if (!this.discarding) {
        this.bufferBytes += this.encoder.encode(piece).length;
        if (this.bufferBytes > this.maxLineBytes) {
          this.discarding = true;
          this.buffer = '';
          this.bufferBytes = 0;
          this.onOversize();
        } else {
          this.buffer += piece;
        }
      }
      if (newline === -1) return;
      if (!this.discarding) {
        const line = this.buffer.replace(/\r$/, '');
        if (line.trim()) this.onLine(line);
      }
      this.buffer = '';
      this.bufferBytes = 0;
      this.discarding = false;
      start = newline + 1;
    }
  }
}

/**
 * Serves one session over a line stream. Requests are handled concurrently
 * (the kernel gate serializes the expensive ones); each response is written
 * as one line when it is ready. Resolves when the input ends and every
 * in-flight request has answered.
 */
export async function serveMcpLines(
  input: AsyncIterable<Uint8Array | string>,
  write: (line: string) => void,
  session: McpSession,
  maxLineBytes = MAX_MCP_LINE_BYTES
): Promise<void> {
  const inFlight = new Set<Promise<void>>();
  const send = (response: JsonRpcResponse | null) => {
    if (response) write(`${JSON.stringify(response)}\n`);
  };
  const framer = new LineFramer(
    maxLineBytes,
    (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        send(failure(null, JSON_RPC_PARSE_ERROR, 'Parse error.'));
        return;
      }
      const task = session
        .handle(message)
        .then(send, () =>
          send(failure(null, JSON_RPC_INTERNAL_ERROR, 'Internal error.'))
        );
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    },
    () =>
      send(
        failure(
          null,
          JSON_RPC_INVALID_REQUEST,
          `Request larger than ${maxLineBytes} bytes was discarded.`
        )
      )
  );
  for await (const chunk of input) framer.push(chunk);
  framer.push('\n');
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}
