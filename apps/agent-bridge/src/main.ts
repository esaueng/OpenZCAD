import {
  AGENT_API_INSTRUCTIONS,
  McpSession,
  createAgentApi,
  serveMcpLines
} from '@openzcad/agent-api';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { preflightCadPatch } from '../../web/src/lib/aiPatchPreflight';
import { USAGE, parseBridgeArguments } from './args';
import { FileWorkspace, openGrants } from './fileWorkspace';

export const BRIDGE_VERSION = '0.1.0';

export interface BridgeIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/**
 * The server makes no network request: plaintext stays on this machine and
 * goes only to the agent that spawned it. Replacing the web network globals
 * turns any accidental use into a loud refusal rather than a silent upload.
 */
export function installNetworkGuard(): void {
  const refuse = () => {
    throw new Error('openzcad-mcp makes no network requests.');
  };
  const scope = globalThis as Record<string, unknown>;
  scope.fetch = async () => refuse();
  for (const name of ['WebSocket', 'EventSource', 'XMLHttpRequest'])
    if (name in scope)
      scope[name] = class {
        constructor() {
          refuse();
        }
      };
}

/**
 * stdout carries the protocol and nothing else. Library code that logs
 * through `console` is routed to stderr so it can never corrupt a message.
 */
function routeConsoleToStderr(stderr: NodeJS.WritableStream): void {
  const write = (...values: unknown[]) =>
    stderr.write(
      `${values.map((value) => (typeof value === 'string' ? value : String(value))).join(' ')}\n`
    );
  console.log = write;
  console.info = write;
  console.debug = write;
  console.warn = write;
  console.error = write;
}

export async function main(
  argv: readonly string[],
  io: BridgeIo = process
): Promise<number> {
  let args;
  try {
    args = parseBridgeArguments(argv);
  } catch (error) {
    io.stderr.write(`openzcad-mcp: ${(error as Error).message}\n`);
    return 2;
  }
  if (args.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  if (io.stdin.isTTY) {
    io.stderr.write(
      'openzcad-mcp: this server is started by an MCP agent host over stdio, not run in a terminal. See --help.\n'
    );
    return 2;
  }
  routeConsoleToStderr(io.stderr);
  installNetworkGuard();
  let grants;
  try {
    grants = await openGrants(args.projects);
  } catch (error) {
    io.stderr.write(`openzcad-mcp: ${(error as Error).message}\n`);
    return 2;
  }
  const workspace = new FileWorkspace(grants, (resolveSourceBytes) =>
    createExactKernelAdapter({ resolveSourceBytes })
  );
  const api = createAgentApi({
    workspace,
    preflight: preflightCadPatch,
    scope: args.scope,
    limits: args.limits
  });
  const session = new McpSession({
    api,
    serverInfo: { name: 'openzcad', version: BRIDGE_VERSION },
    instructions: AGENT_API_INSTRUCTIONS,
    log: (message) => io.stderr.write(`openzcad-mcp: ${message}\n`)
  });
  io.stderr.write(
    `openzcad-mcp: serving ${grants.map((grant) => grant.alias).join(', ')} with ${args.scope} scope\n`
  );
  try {
    await serveMcpLines(
      io.stdin as AsyncIterable<Uint8Array | string>,
      (line) => io.stdout.write(line),
      session
    );
  } finally {
    await workspace.dispose();
  }
  return 0;
}
