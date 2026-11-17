/**
 * L14 end to end: spawn the real `openzcad-mcp` server over stdio, drive a
 * real edit through MCP the way an agent host does (initialize, list,
 * digest, preflight, apply), and check the project file on disk with the
 * exact kernel afterwards. A network tripwire preloaded into the server
 * proves the whole session stayed off the network.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import { parseProjectBackup } from '../apps/web/src/lib/projectBackup';

const BIN = fileURLToPath(
  new URL('../apps/agent-bridge/bin/openzcad-mcp.mjs', import.meta.url)
);
const TRIPWIRE = fileURLToPath(
  new URL('./fixtures/network-tripwire.mjs', import.meta.url)
);

interface Response {
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** A minimal MCP host: one child process, requests matched by id. */
class StdioClient {
  readonly child: ChildProcessWithoutNullStreams;
  stderr = '';
  private buffer = '';
  private nextId = 1;
  private readonly waiting = new Map<number, (response: Response) => void>();
  readonly exited: Promise<number | null>;

  constructor(args: string[]) {
    this.child = spawn(process.execPath, ['--import', TRIPWIRE, BIN, ...args], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (text: string) => (this.stderr += text));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (text: string) => {
      this.buffer += text;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        // Every stdout line must be a protocol message.
        const response = JSON.parse(line) as Response;
        this.waiting.get(response.id as number)?.(response);
        this.waiting.delete(response.id as number);
      }
    });
    this.exited = new Promise((resolve) => this.child.on('exit', resolve));
  }

  request(method: string, params?: unknown): Promise<Response> {
    const id = this.nextId++;
    const answer = new Promise<Response>((resolve) =>
      this.waiting.set(id, resolve)
    );
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    );
    return answer;
  }

  notify(method: string) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async call(name: string, args: Record<string, unknown>) {
    const response = await this.request('tools/call', {
      name,
      arguments: args
    });
    const result = response.result as {
      content: { text: string }[];
      structuredContent: Record<string, unknown>;
      isError: boolean;
    };
    expect(JSON.parse(result.content[0]!.text)).toEqual(
      result.structuredContent
    );
    return { ...result.structuredContent, isError: result.isError } as Record<
      string,
      unknown
    > & { isError: boolean };
  }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'l14-e2e', version: '1' }
    });
    this.notify('notifications/initialized');
    return response;
  }

  async close() {
    this.child.stdin.end();
    return this.exited;
  }
}

type BoxData = { dimensions: { width: number; height: number; depth: number } };
const width = (document: ProjectDocument) =>
  (listFeaturesInOrder(document)[0]!.data as unknown as BoxData).dimensions
    .width;

describe('openzcad-mcp over stdio', { timeout: 180_000 }, () => {
  let directory: string;
  let projectPath: string;
  let original: Buffer;
  let adapter: ExactKernelAdapter;
  let featureId: string;

  const proposal = (value: number) => ({
    proposalId: `width-${value}`,
    summary: `Make the block ${value} mm wide`,
    assumptions: [],
    operations: [
      { kind: 'set_feature_dimension', featureId, field: 'width', value }
    ]
  });

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    const document = addPrimitiveFeature(
      createProjectDocument('Block', toUserId('user_agent_e2e')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 30, depth: 20 }
      }
    );
    featureId = listFeaturesInOrder(document)[0]!.featureId;
    directory = await mkdtemp(join(tmpdir(), 'openzcad-mcp-'));
    projectPath = join(directory, 'Block.openzcad');
    await writeFile(
      projectPath,
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document: withoutDerivedProjection(document),
        files: []
      })
    );
    await chmod(projectPath, 0o600);
    original = await readFile(projectPath);
  });

  afterAll(async () => {
    adapter.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it('drives a real edit: digest, exact preflight, one undoable apply', async () => {
    const client = new StdioClient([
      '--project',
      projectPath,
      '--scope',
      'edit'
    ]);
    try {
      const init = await client.initialize();
      expect(init.result).toMatchObject({
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'openzcad' },
        capabilities: { tools: {} }
      });
      const tools = (await client.request('tools/list')).result as {
        tools: { name: string }[];
      };
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'list_projects',
        'get_document',
        'get_digest',
        'get_patch_schema',
        'preflight_patch',
        'apply_patch',
        'get_history_text',
        'preflight_history_text',
        'apply_history_text'
      ]);

      const listed = await client.call('list_projects', {});
      const [project] = listed.projects as {
        alias: string;
        version: number;
        schemaVersion: number;
      }[];
      expect(listed.scope).toBe('edit');
      expect(project).toMatchObject({
        alias: 'block',
        name: 'Block',
        schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION
      });
      const version = project!.version;

      // The canonical document and the exact digest.
      const document = await client.call('get_document', { project: 'block' });
      expect(
        (document.document as { projectId: string }).projectId
      ).toBeTruthy();
      const digest = await client.call('get_digest', { project: 'block' });
      const bodies = (digest.digest as { bodies: { volume: number }[] }).bodies;
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.volume).toBeCloseTo(40 * 30 * 20, 6);

      // Exact preflight reports the change and writes nothing.
      const checked = await client.call('preflight_patch', {
        project: 'block',
        expectedVersion: version,
        proposal: proposal(60)
      });
      expect(checked.message).toBeUndefined();
      expect(checked).toMatchObject({
        ok: true,
        applied: false,
        isError: false
      });
      const change = (
        checked.bodies as {
          change: string;
          before: { volume: number };
          after: { volume: number };
        }[]
      )[0]!;
      expect(change.change).toBe('changed');
      expect(change.before.volume).toBeCloseTo(24_000, 6);
      expect(change.after.volume).toBeCloseTo(36_000, 6);
      expect(await readFile(projectPath)).toEqual(original);

      // A refused patch and a stale one leave the file byte-identical.
      const refused = await client.call('apply_patch', {
        project: 'block',
        expectedVersion: version,
        proposal: proposal(-5)
      });
      expect(refused).toMatchObject({ ok: false, isError: true });
      const stale = await client.call('apply_patch', {
        project: 'block',
        expectedVersion: version - 1,
        proposal: proposal(60)
      });
      expect(stale).toMatchObject({ ok: false, error: 'conflict' });
      expect(await readFile(projectPath)).toEqual(original);

      // The real edit.
      const applied = await client.call('apply_patch', {
        project: 'block',
        expectedVersion: version,
        proposal: proposal(60)
      });
      expect(applied.message).toBeUndefined();
      expect(applied).toMatchObject({
        ok: true,
        applied: true,
        previousVersion: version,
        undoLabel: 'Apply agent patch'
      });

      // The file is a backup the app's own importer accepts.
      const saved = await parseProjectBackup(
        await readFile(projectPath, 'utf8')
      );
      const after = saved.document;
      expect(after.version).toBe(applied.version);
      expect(width(after)).toBe(60);
      const history = after.editHistory!;
      expect(history.entries.at(-1)!.label).toBe('Apply agent patch');
      expect(history.cursor).toBe(history.entries.length);
      const derivedAfter = await adapter.syncDocument(after);
      const [bodyId] = derivedAfter.exportableBodyIds;
      expect(derivedAfter.bodyRepresentations[bodyId!]!.volume).toBeCloseTo(
        36_000,
        6
      );

      // One undo restores the whole change.
      const undone = new CommandManager(after).undo();
      expect(width(undone)).toBe(40);
      const derivedUndone = await adapter.syncDocument(undone);
      expect(
        derivedUndone.bodyRepresentations[derivedUndone.exportableBodyIds[0]!]!
          .volume
      ).toBeCloseTo(24_000, 6);

      // The server sees its own write; the old version is now stale.
      const again = await client.call('apply_patch', {
        project: 'block',
        expectedVersion: version,
        proposal: proposal(80)
      });
      expect(again).toMatchObject({ error: 'conflict' });
    } finally {
      expect(await client.close()).toBe(0);
    }
    expect(client.stderr).not.toContain('NETWORK-TRIPWIRE');
  });

  it('enforces the granted scope and project', async () => {
    const before = await readFile(projectPath);
    const client = new StdioClient([
      '--project',
      projectPath,
      '--scope',
      'preflight'
    ]);
    try {
      await client.initialize();
      const tools = (await client.request('tools/list')).result as {
        tools: { name: string }[];
      };
      expect(tools.tools.map((tool) => tool.name)).not.toContain('apply_patch');
      const listed = await client.call('list_projects', {});
      const version = (listed.projects as { version: number }[])[0]!.version;
      const refused = await client.call('apply_patch', {
        project: 'block',
        expectedVersion: version,
        proposal: proposal(70)
      });
      expect(refused).toMatchObject({ ok: false, error: 'scope' });
      const elsewhere = await client.call('get_document', {
        project: '/etc/passwd'
      });
      expect(elsewhere).toMatchObject({ ok: false, error: 'not_found' });
    } finally {
      expect(await client.close()).toBe(0);
    }
    expect(await readFile(projectPath)).toEqual(before);
    expect(client.stderr).not.toContain('NETWORK-TRIPWIRE');
  });
});
