import {
  isAgentScope,
  type AgentRateLimits,
  type AgentScope
} from '@openzcad/agent-api';

export interface BridgeArguments {
  projects: string[];
  scope: AgentScope;
  limits: Partial<AgentRateLimits>;
  help: boolean;
}

export const USAGE = `openzcad-mcp — the OpenZCAD agent API (MCP) over stdio

Usage:
  openzcad-mcp --project <file.openzcad> [--project <file>...] [--scope read|preflight|edit]

Options:
  --project <path>        A project backup (.openzcad) the agent may use. Repeat
                          for several. Required; nothing else is reachable.
  --scope <scope>         read: list and read projects. preflight (default):
                          also check patches on the exact kernel. edit: also
                          apply checked patches to the file.
  --reads-per-minute <n>  Lower the read limit (default and maximum 120).
  --kernel-per-minute <n> Lower the exact-kernel limit (default and maximum 12).
  --help                  Show this text.

The server speaks MCP on stdin and stdout and is started by your agent host.
It opens no network connection and never contacts OpenZCAD. Whatever a tool
returns is sent by your agent to its model provider under that provider's
terms. Applied changes are one undo step ("Apply agent patch") once the file
is imported into OpenZCAD; keep the server and the app on the same release.
`;

function positiveInteger(flag: string, value: string | undefined): number {
  const number = Number(value);
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(number))
    throw new Error(`${flag} needs a positive whole number.`);
  return number;
}

export function parseBridgeArguments(argv: readonly string[]): BridgeArguments {
  const result: BridgeArguments = {
    projects: [],
    scope: 'preflight',
    limits: {},
    help: false
  };
  let scopeSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--'))
        throw new Error(`${flag} needs a value.`);
      index += 1;
      return next;
    };
    switch (flag) {
      case '--help':
      case '-h':
        result.help = true;
        break;
      case '--project':
        result.projects.push(value());
        break;
      case '--scope': {
        if (scopeSeen) throw new Error('--scope may be given once.');
        scopeSeen = true;
        const scope = value();
        if (!isAgentScope(scope))
          throw new Error('--scope must be read, preflight or edit.');
        result.scope = scope;
        break;
      }
      case '--reads-per-minute':
        result.limits.readPerMinute = positiveInteger(flag, value());
        result.limits.readBurst = Math.min(30, result.limits.readPerMinute);
        break;
      case '--kernel-per-minute':
        result.limits.kernelPerMinute = positiveInteger(flag, value());
        result.limits.kernelBurst = Math.min(4, result.limits.kernelPerMinute);
        break;
      default:
        throw new Error(`Unknown option ${flag}. See --help.`);
    }
  }
  if (!result.help && result.projects.length === 0)
    throw new Error('Grant at least one project with --project <file>.');
  return result;
}
