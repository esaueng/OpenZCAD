import { describe, expect, it } from 'vitest';
import { CommandManager, commandsForCadPatch } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  AGENT_PATCH_UNDO_LABEL,
  AgentToolError,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  KernelGate,
  LineFramer,
  McpSession,
  TokenBucket,
  boundedRateLimits,
  createAgentApi,
  serveMcpLines,
  type AgentApiOptions,
  type AgentWorkspace,
  type LoadedProject,
  type PatchPreflight
} from './index';

function boxDocument(): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument('Block', toUserId('user_agent')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 30, depth: 20 }
    }
  );
}

const emptyDerived = (): ProjectDocument['derived'] => ({
  bodyRepresentations: {},
  exportableBodyIds: [],
  warnings: [],
  updatedAt: new Date(0).toISOString()
});

/** An in-memory workspace: one project, a revision counter, call logs. */
class MemoryWorkspace implements AgentWorkspace {
  revision = 1;
  derives = 0;
  commits: ProjectDocument[] = [];
  constructor(public document: ProjectDocument) {}
  async projects() {
    return [
      {
        alias: 'block',
        projectId: this.document.projectId,
        name: this.document.name,
        units: this.document.units,
        version: this.document.version,
        schemaVersion: this.document.schemaVersion
      }
    ];
  }
  async load(project: string): Promise<LoadedProject> {
    if (project !== 'block' && project !== this.document.projectId)
      throw new AgentToolError('not_found', 'No such project.');
    return { document: this.document, revision: String(this.revision) };
  }
  async derive() {
    this.derives += 1;
    return emptyDerived();
  }
  async commit(project: string, revision: string, next: ProjectDocument) {
    if (revision !== String(this.revision))
      throw new AgentToolError('conflict', 'Moved.');
    this.document = next;
    this.revision += 1;
    this.commits.push(next);
    return this.load(project);
  }
}

/** The command list the real preflight would build, without a kernel. */
const commandPreflight: PatchPreflight = async (base, proposal, derive) => {
  const commands = commandsForCadPatch(base, proposal);
  const candidate = new CommandManager(base).runTransaction(
    'Preflight AI patch',
    commands
  );
  return {
    commands,
    candidate: { ...candidate, derived: await derive(candidate) },
    targets: []
  };
};

function widthProposal(document: ProjectDocument, width: number) {
  const feature = listFeaturesInOrder(document)[0]!;
  return {
    proposalId: 'widen',
    summary: `Make the block ${width} wide`,
    assumptions: [],
    operations: [
      {
        kind: 'set_feature_dimension',
        featureId: feature.featureId,
        field: 'width',
        value: width
      }
    ]
  };
}

function api(overrides: Partial<AgentApiOptions> = {}) {
  const workspace = new MemoryWorkspace(boxDocument());
  return {
    workspace,
    api: createAgentApi({
      workspace,
      preflight: commandPreflight,
      scope: 'edit',
      ...overrides
    })
  };
}

const parsed = (result: { content: { text: string }[] }) =>
  JSON.parse(result.content[0]!.text) as Record<string, unknown>;

describe('agent API scope', () => {
  it('lists only the tools the granted scope allows', () => {
    const names = (scope: 'read' | 'preflight' | 'edit') =>
      api({ scope })
        .api.tools()
        .map((tool) => tool.name);
    expect(names('read')).toEqual([
      'list_projects',
      'get_document',
      'get_digest',
      'get_patch_schema'
    ]);
    expect(names('preflight')).toEqual([...names('read'), 'preflight_patch']);
    expect(names('edit')).toEqual([...names('preflight'), 'apply_patch']);
  });

  it('refuses a tool outside the scope and writes nothing', async () => {
    const { api: readOnly, workspace } = api({ scope: 'preflight' });
    const result = await readOnly.call('apply_patch', {
      project: 'block',
      expectedVersion: workspace.document.version,
      proposal: widthProposal(workspace.document, 60)
    });
    expect(result.isError).toBe(true);
    expect(parsed(result)).toMatchObject({ ok: false, error: 'scope' });
    expect(workspace.commits).toHaveLength(0);
    expect(workspace.derives).toBe(0);
  });

  it('marks only apply_patch as writing', () => {
    const tools = api().api.tools();
    expect(
      tools.filter((tool) => !tool.annotations.readOnlyHint).map((t) => t.name)
    ).toEqual(['apply_patch']);
    expect(
      tools.find((tool) => tool.name === 'apply_patch')!.annotations
        .destructiveHint
    ).toBe(true);
  });

  it('constrains the patch tools by the assistant patch schema', () => {
    const tools = api().api.tools();
    const schema = tools.find((tool) => tool.name === 'get_patch_schema');
    expect(schema).toBeDefined();
    for (const name of ['preflight_patch', 'apply_patch']) {
      const tool = tools.find((entry) => entry.name === name)!;
      const properties = tool.inputSchema.properties as Record<
        string,
        { properties?: Record<string, unknown> }
      >;
      expect(properties.proposal?.properties).toHaveProperty('operations');
    }
  });
});

describe('agent API patch contract', () => {
  it('applies a checked patch as one undoable transaction', async () => {
    const { api: edit, workspace } = api();
    const before = workspace.document;
    const result = await edit.call('apply_patch', {
      project: 'block',
      expectedVersion: before.version,
      proposal: widthProposal(before, 60)
    });
    expect(result.isError).toBe(false);
    const report = parsed(result);
    expect(report).toMatchObject({
      ok: true,
      applied: true,
      previousVersion: before.version,
      undoLabel: AGENT_PATCH_UNDO_LABEL
    });
    expect(workspace.commits).toHaveLength(1);
    const after = workspace.document;
    expect(report.version).toBe(after.version);
    expect(after.version).toBeGreaterThan(before.version);
    const history = after.editHistory!;
    expect(history.cursor).toBe((before.editHistory?.cursor ?? 0) + 1);
    expect(history.entries.at(-1)!.label).toBe(AGENT_PATCH_UNDO_LABEL);
    const feature = (doc: ProjectDocument) =>
      listFeaturesInOrder(doc)[0]!.data as unknown as {
        dimensions: { width: number };
      };
    expect(feature(after).dimensions.width).toBe(60);
    const undone = new CommandManager(after).undo();
    expect(feature(undone).dimensions.width).toBe(40);
    expect(undone.editHistory!.cursor).toBe(history.cursor - 1);
  });

  it('preflights without writing', async () => {
    const { api: edit, workspace } = api();
    const result = await edit.call('preflight_patch', {
      project: 'block',
      proposal: widthProposal(workspace.document, 60)
    });
    const report = parsed(result);
    expect(report).toMatchObject({
      ok: true,
      applied: false,
      version: workspace.document.version
    });
    expect(report.candidateVersion).toBeGreaterThan(workspace.document.version);
    expect(workspace.commits).toHaveLength(0);
  });

  it('refuses a stale expectedVersion before any kernel work', async () => {
    const { api: edit, workspace } = api();
    const result = await edit.call('apply_patch', {
      project: 'block',
      expectedVersion: workspace.document.version + 5,
      proposal: widthProposal(workspace.document, 60)
    });
    expect(parsed(result)).toMatchObject({ error: 'conflict' });
    expect(workspace.derives).toBe(0);
    expect(workspace.commits).toHaveLength(0);
  });

  it('does not spend exact-kernel budget on a stale call', async () => {
    const { api: edit, workspace } = api({
      now: () => 0,
      limits: { kernelPerMinute: 1, kernelBurst: 1 }
    });
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect(
        parsed(
          await edit.call('preflight_patch', {
            project: 'block',
            expectedVersion: workspace.document.version + 1,
            proposal: widthProposal(workspace.document, 60)
          })
        )
      ).toMatchObject({ error: 'conflict' });
    expect(
      (
        await edit.call('preflight_patch', {
          project: 'block',
          expectedVersion: workspace.document.version,
          proposal: widthProposal(workspace.document, 60)
        })
      ).isError
    ).toBe(false);
  });

  it('requires expectedVersion to apply', async () => {
    const { api: edit, workspace } = api();
    const result = await edit.call('apply_patch', {
      project: 'block',
      proposal: widthProposal(workspace.document, 60)
    });
    expect(parsed(result)).toMatchObject({ error: 'invalid' });
  });

  it('refuses a proposal naming a feature the project lacks', async () => {
    const { api: edit, workspace } = api();
    const result = await edit.call('apply_patch', {
      project: 'block',
      expectedVersion: workspace.document.version,
      proposal: {
        ...widthProposal(workspace.document, 60),
        operations: [
          {
            kind: 'set_feature_dimension',
            featureId: 'feature_missing',
            field: 'width',
            value: 60
          }
        ]
      }
    });
    const refusal = parsed(result);
    expect(refusal).toMatchObject({ ok: false, error: 'refused' });
    expect(refusal.message).toMatch(/feature_missing not found/);
    expect(workspace.commits).toHaveLength(0);
  });

  it('refuses a proposal that fails the patch schema', async () => {
    const { api: edit, workspace } = api();
    const result = await edit.call('preflight_patch', {
      project: 'block',
      proposal: { proposalId: 'x', operations: [{ kind: 'format_disk' }] }
    });
    const refusal = parsed(result);
    expect(refusal).toMatchObject({ ok: false, error: 'invalid' });
    expect(refusal.message).toMatch(/^The proposal is not valid/);
    expect(workspace.derives).toBe(1);
  });

  it('refuses drawing-sheet operations', async () => {
    const { api: edit, workspace } = api();
    const result = await edit.call('preflight_patch', {
      project: 'block',
      proposal: {
        proposalId: 'x',
        summary: 'Remove notes',
        assumptions: [],
        operations: [
          {
            kind: 'remove_drawing_annotations',
            sheetId: 'sheet_1',
            annotationIds: ['a']
          }
        ]
      }
    });
    expect(parsed(result)).toMatchObject({ ok: false, error: 'invalid' });
    expect(workspace.commits).toHaveLength(0);
  });

  it('reports an exact refusal and writes nothing', async () => {
    const { workspace } = api();
    const refusing = createAgentApi({
      workspace,
      scope: 'edit',
      preflight: async () => {
        throw new Error(
          'Block did not produce its expected exact result body.'
        );
      }
    });
    const result = await refusing.call('apply_patch', {
      project: 'block',
      expectedVersion: workspace.document.version,
      proposal: widthProposal(workspace.document, 60)
    });
    expect(parsed(result)).toMatchObject({
      error: 'refused',
      message: 'Block did not produce its expected exact result body.'
    });
    expect(workspace.commits).toHaveLength(0);
  });

  it('refuses unknown arguments and unknown projects', async () => {
    const { api: edit } = api();
    expect(
      parsed(await edit.call('get_document', { project: 'block', path: '/' }))
    ).toMatchObject({ error: 'invalid' });
    expect(
      parsed(await edit.call('get_document', { project: '../etc/passwd' }))
    ).toMatchObject({ error: 'not_found' });
  });

  it('answers the canonical document without derived state or undo history', async () => {
    const { api: edit, workspace } = api();
    const result = parsed(
      await edit.call('get_document', { project: 'block' })
    );
    const document = result.document as Record<string, unknown>;
    expect(document.projectId).toBe(workspace.document.projectId);
    expect(document).not.toHaveProperty('derived');
    expect(document).not.toHaveProperty('editHistory');
    const small = createAgentApi({
      workspace,
      preflight: commandPreflight,
      scope: 'read',
      maxDocumentBytes: 100
    });
    expect(
      parsed(await small.call('get_document', { project: 'block' }))
    ).toMatchObject({ error: 'too_large' });
  });

  it('caches the exact digest per stored revision', async () => {
    const { api: edit, workspace } = api();
    await edit.call('get_digest', { project: 'block' });
    await edit.call('get_digest', { project: 'block' });
    expect(workspace.derives).toBe(1);
    workspace.revision += 1;
    await edit.call('get_digest', { project: 'block' });
    expect(workspace.derives).toBe(2);
  });
});

describe('agent API rate limits', () => {
  it('may lower but never raise the defaults', () => {
    expect(boundedRateLimits({ kernelPerMinute: 3 }).kernelPerMinute).toBe(3);
    expect(() => boundedRateLimits({ kernelPerMinute: 13 })).toThrow(
      /lowered, not raised/
    );
    expect(() => boundedRateLimits({ readPerMinute: 0 })).toThrow(
      /positive whole number/
    );
  });

  it('refills a token bucket over time', () => {
    let now = 0;
    const bucket = new TokenBucket(2, 6, () => now);
    bucket.take('kernel');
    bucket.take('kernel');
    let refusal: unknown;
    try {
      bucket.take('kernel');
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(AgentToolError);
    expect((refusal as AgentToolError).code).toBe('rate_limited');
    expect((refusal as AgentToolError).retryAfterMs).toBe(10_000);
    now = 10_000;
    expect(() => bucket.take('kernel')).not.toThrow();
  });

  it('limits kernel calls separately from reads', async () => {
    let now = 0;
    const { api: edit, workspace } = api({
      now: () => now,
      limits: { kernelPerMinute: 2, kernelBurst: 2 }
    });
    const preflight = () =>
      edit.call('preflight_patch', {
        project: 'block',
        proposal: widthProposal(workspace.document, 60)
      });
    expect((await preflight()).isError).toBe(false);
    expect((await preflight()).isError).toBe(false);
    const limited = parsed(await preflight());
    expect(limited).toMatchObject({ error: 'rate_limited' });
    expect(limited.retryAfterMs).toBe(30_000);
    expect((await edit.call('list_projects', {})).isError).toBe(false);
    now = 30_000;
    expect((await preflight()).isError).toBe(false);
  });

  it('limits reads', async () => {
    const { api: edit } = api({
      now: () => 0,
      limits: { readPerMinute: 2, readBurst: 2 }
    });
    await edit.call('list_projects', {});
    await edit.call('list_projects', {});
    expect(parsed(await edit.call('list_projects', {}))).toMatchObject({
      error: 'rate_limited'
    });
  });
});

describe('kernel gate', () => {
  it('runs one job, lets one wait and refuses a third', async () => {
    const gate = new KernelGate(60_000);
    let finish!: () => void;
    const first = gate.run(
      () => new Promise<string>((resolve) => (finish = () => resolve('a')))
    );
    const order: string[] = [];
    const second = gate.run(async () => {
      order.push('second');
      return 'b';
    });
    await expect(gate.run(async () => 'c')).rejects.toMatchObject({
      code: 'busy'
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    finish();
    await expect(first).resolves.toBe('a');
    await expect(second).resolves.toBe('b');
    expect(gate.queued).toBe(0);
  });

  it('reports a timeout at once but holds the kernel until the job settles', async () => {
    const gate = new KernelGate(10);
    let signalled: AbortSignal | undefined;
    let finish!: () => void;
    const slow = gate.run(
      (signal) =>
        new Promise<void>((resolve) => {
          signalled = signal;
          finish = resolve;
        })
    );
    await expect(slow).rejects.toMatchObject({ code: 'timeout' });
    expect(signalled!.aborted).toBe(true);
    const ran: string[] = [];
    const next = gate.run(async () => ran.push('next'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toEqual([]);
    finish();
    await next;
    expect(ran).toEqual(['next']);
  });

  it('never commits a patch whose call already timed out', async () => {
    const workspace = new MemoryWorkspace(boxDocument());
    let release!: () => void;
    const timedOut = createAgentApi({
      workspace,
      scope: 'edit',
      kernelTimeoutMs: 10,
      preflight: async (base, proposal, derive) => {
        await new Promise<void>((resolve) => (release = resolve));
        return commandPreflight(base, proposal, derive);
      }
    });
    const result = await timedOut.call('apply_patch', {
      project: 'block',
      expectedVersion: workspace.document.version,
      proposal: widthProposal(workspace.document, 60)
    });
    expect(parsed(result)).toMatchObject({ error: 'timeout' });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(workspace.commits).toHaveLength(0);
  });
});

describe('MCP session', () => {
  const session = () =>
    new McpSession({
      api: api().api,
      serverInfo: { name: 'openzcad', version: 'test' },
      instructions: 'Use the tools.'
    });

  it('negotiates the protocol revision', async () => {
    const known = await session().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} }
    });
    expect(known?.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'openzcad' },
      instructions: 'Use the tools.'
    });
    const unknown = await session().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' }
    });
    expect(unknown?.result).toMatchObject({ protocolVersion: '2025-11-25' });
  });

  it('serves no tools before initialize', async () => {
    const response = await session().handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    });
    expect(response?.error?.code).toBe(JSON_RPC_INVALID_REQUEST);
  });

  it('lists and calls tools after initialize', async () => {
    const mcp = session();
    await mcp.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' }
    });
    expect(
      await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
    ).toBeNull();
    expect(mcp.ready).toBe(true);
    const list = await mcp.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    });
    expect(
      (list?.result as { tools: { name: string }[] }).tools.map((t) => t.name)
    ).toContain('apply_patch');
    const call = await mcp.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_projects', arguments: {} }
    });
    expect(call?.result).toMatchObject({ isError: false });
    const unknownTool = await mcp.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'rm_rf', arguments: {} }
    });
    expect(unknownTool?.error?.code).toBe(JSON_RPC_INVALID_PARAMS);
    const unknownMethod = await mcp.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/list'
    });
    expect(unknownMethod?.error?.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
  });

  it('refuses malformed messages and batches', async () => {
    const mcp = session();
    expect((await mcp.handle([]))?.error?.code).toBe(JSON_RPC_INVALID_REQUEST);
    expect(
      (await mcp.handle({ jsonrpc: '1.0', id: 1, method: 'ping' }))?.error?.code
    ).toBe(JSON_RPC_INVALID_REQUEST);
    expect(
      (await mcp.handle({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }))
        ?.error?.code
    ).toBe(JSON_RPC_INVALID_REQUEST);
    expect(
      await mcp.handle({ jsonrpc: '2.0', id: 'p', method: 'ping' })
    ).toEqual({ jsonrpc: '2.0', id: 'p', result: {} });
  });
});

describe('MCP line transport', () => {
  it('frames lines across chunks and skips an oversized line', () => {
    const lines: string[] = [];
    let oversized = 0;
    const framer = new LineFramer(
      16,
      (line) => lines.push(line),
      () => (oversized += 1)
    );
    framer.push('{"a":');
    framer.push('1}\r\n{"b":2}\n');
    framer.push('x'.repeat(10));
    framer.push('y'.repeat(10));
    framer.push('z\n{"c":3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(oversized).toBe(1);
  });

  it('answers parse errors and serves requests over a stream', async () => {
    const written: string[] = [];
    async function* input() {
      yield '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n';
      yield 'not json\n';
      yield '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}';
    }
    await serveMcpLines(
      input(),
      (line) => written.push(line),
      new McpSession({
        api: api().api,
        serverInfo: { name: 'openzcad', version: 'test' }
      })
    );
    const responses = written.map(
      (line) =>
        JSON.parse(line) as {
          id: number | null;
          error?: { code: number };
          result?: { isError: boolean };
        }
    );
    expect(written.every((line) => line.endsWith('\n'))).toBe(true);
    expect(responses.find((r) => r.id === null)?.error?.code).toBe(
      JSON_RPC_PARSE_ERROR
    );
    expect(responses.find((r) => r.id === 2)?.result?.isError).toBe(false);
  });
});
