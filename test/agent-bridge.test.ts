import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { parseBridgeArguments } from '../apps/agent-bridge/src/args';
import {
  FileWorkspace,
  grantPathProblem,
  openGrants
} from '../apps/agent-bridge/src/fileWorkspace';
import { installNetworkGuard } from '../apps/agent-bridge/src/main';

const posix = typeof process.getuid === 'function';

function blockDocument(): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument('Block', toUserId('user_bridge')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 30, depth: 20 }
    }
  );
}

const backupText = (document: ProjectDocument) =>
  JSON.stringify({
    format: 'openzcad-project',
    version: 1,
    document: withoutDerivedProjection(document),
    files: []
  });

const noKernel = () => Promise.reject(new Error('no kernel in this test'));

describe('openzcad-mcp arguments', () => {
  it('requires a project grant and defaults to preflight scope', () => {
    expect(() => parseBridgeArguments([])).toThrow(/--project/);
    expect(parseBridgeArguments(['--project', 'a.openzcad'])).toMatchObject({
      projects: ['a.openzcad'],
      scope: 'preflight'
    });
  });

  it('parses scope and lowered limits, refusing anything else', () => {
    expect(
      parseBridgeArguments([
        '--project',
        'a',
        '--project',
        'b',
        '--scope',
        'edit',
        '--kernel-per-minute',
        '2'
      ])
    ).toMatchObject({
      projects: ['a', 'b'],
      scope: 'edit',
      limits: { kernelPerMinute: 2, kernelBurst: 2 }
    });
    expect(() =>
      parseBridgeArguments(['--project', 'a', '--scope', 'admin'])
    ).toThrow(/read, preflight or edit/);
    expect(() =>
      parseBridgeArguments([
        '--project',
        'a',
        '--scope',
        'read',
        '--scope',
        'edit'
      ])
    ).toThrow(/once/);
    expect(() =>
      parseBridgeArguments(['--project', 'a', '--listen', '8080'])
    ).toThrow(/Unknown option/);
    expect(() =>
      parseBridgeArguments(['--project', 'a', '--reads-per-minute', 'x'])
    ).toThrow(/whole number/);
  });
});

describe('openzcad-mcp file grants', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openzcad-grants-'));
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  async function project(name: string, text = backupText(blockDocument())) {
    const path = join(directory, name);
    await writeFile(path, text);
    await chmod(path, 0o600);
    return path;
  }

  it('resolves symlinks once and gives each file a distinct alias', async () => {
    const first = await project('My Bracket.openzcad');
    const second = await project('my-bracket.OPENZCAD');
    const link = join(directory, 'link.openzcad');
    await symlink(first, link);
    const grants = await openGrants([first, link, second]);
    expect(grants.map((grant) => grant.alias)).toEqual([
      'my-bracket',
      'my-bracket-2'
    ]);
  });

  it.runIf(posix)('refuses a file other users can write', async () => {
    const path = await project('shared.openzcad');
    await chmod(path, 0o666);
    await expect(openGrants([path])).rejects.toThrow(/writable by other users/);
    await chmod(path, 0o620);
    await expect(openGrants([path])).rejects.toThrow(/writable by other users/);
  });

  it('refuses a granted file later replaced by a link to another project', async () => {
    const granted = await project('granted.openzcad');
    const other = blockDocument();
    const elsewhere = await project('elsewhere.openzcad', backupText(other));
    const workspace = new FileWorkspace(await openGrants([granted]), noKernel);
    await workspace.load('granted');
    await rm(granted);
    await symlink(elsewhere, granted);
    const swapped = await workspace.load('granted').then(
      (loaded) => loaded.document.projectId,
      (error: { code: string }) => error.code
    );
    expect(swapped).toBe('not_found');
    expect(swapped).not.toBe(other.projectId);
  });

  it.runIf(posix)(
    'refuses a granted file whose permissions loosen after startup',
    async () => {
      const path = await project('loosened.openzcad');
      const workspace = new FileWorkspace(await openGrants([path]), noKernel);
      await workspace.load('loosened');
      await chmod(path, 0o666);
      const refusal = await workspace.load('loosened').then(
        () => null,
        (error: { code: string; message: string }) => error
      );
      expect(refusal?.code).toBe('refused');
      expect(refusal?.message).toMatch(/writable by other users/);
    }
  );

  it.runIf(posix)(
    'refuses a folder others can write unless the sticky bit protects it',
    async () => {
      const path = await project('in-open-folder.openzcad');
      try {
        await chmod(directory, 0o777);
        await expect(openGrants([path])).rejects.toThrow(
          /folder on the path to .* is writable by other users/
        );
        await chmod(directory, 0o1777);
        await expect(openGrants([path])).resolves.toHaveLength(1);
      } finally {
        await chmod(directory, 0o700);
      }
    }
  );

  it.runIf(posix)(
    'refuses a grant beneath any ancestor folder others can write',
    async () => {
      // Another account that can write an ancestor could rename the folder
      // below it and put a link to a private folder in its place, after the
      // path was checked and before the file is opened (O_NOFOLLOW guards
      // only the last name). Every ancestor is therefore checked.
      const inner = join(directory, 'inner', 'deeper');
      await mkdir(inner, { recursive: true, mode: 0o700 });
      const path = join(inner, 'nested.openzcad');
      await writeFile(path, backupText(blockDocument()));
      await chmod(path, 0o600);
      const workspace = new FileWorkspace(await openGrants([path]), noKernel);
      await workspace.load('nested');
      try {
        await chmod(join(directory, 'inner'), 0o777);
        await expect(openGrants([path])).rejects.toThrow(
          /folder on the path to .* is writable by other users/
        );
        // A grant made before the ancestor opened up is refused on its next read.
        const refusal = await workspace.load('nested').then(
          () => null,
          (error: { code: string; message: string }) => error
        );
        expect(refusal?.code).toBe('refused');
        expect(refusal?.message).toMatch(/folder on the path/);
        await chmod(join(directory, 'inner'), 0o1777);
        await expect(openGrants([path])).resolves.toHaveLength(1);
      } finally {
        await chmod(join(directory, 'inner'), 0o700);
      }
    }
  );

  it.runIf(posix)(
    'checks every folder up to the root, refusing a link in the path',
    async () => {
      const path = await project('linked.openzcad');
      const link = join(directory, 'via-link');
      await symlink(directory, link);
      // The grant itself resolves links once, so it holds the real path…
      const [grant] = await openGrants([join(link, 'linked.openzcad')]);
      expect(grant!.path).toBe(await realpath(path));
      // …and the strict-path walk reads each folder without following links.
      expect(
        await grantPathProblem(join(link, 'linked.openzcad'), 'x')
      ).toMatch(/not a plain folder/);
      expect(await grantPathProblem(await realpath(path), 'x')).toBeNull();
    }
  );

  it('refuses a missing file or a directory', async () => {
    await expect(
      openGrants([join(directory, 'none.openzcad')])
    ).rejects.toThrow(/Cannot open/);
    await expect(openGrants([directory])).rejects.toThrow(/not a file/);
  });

  it('refuses ciphertext and other non-backup files by shape', async () => {
    const encrypted = await project(
      'sealed.openzcad',
      'OZE2\u0000\u0001binary-envelope'
    );
    const workspace = new FileWorkspace(
      await openGrants([encrypted]),
      noKernel
    );
    const sealed = await workspace.load('sealed').then(
      () => null,
      (error: unknown) => error as { code: string; message: string }
    );
    expect(sealed?.code).toBe('invalid');
    expect(sealed?.message).toMatch(/not a plaintext OpenZCAD project backup/);
    const json = await project('other.openzcad', '{"format":"something-else"}');
    const other = new FileWorkspace(await openGrants([json]), noKernel);
    await expect(other.load('other')).rejects.toMatchObject({
      code: 'invalid'
    });
  });

  it('resolves projects by alias or projectId only', async () => {
    const document = blockDocument();
    const path = await project('block.openzcad', backupText(document));
    const workspace = new FileWorkspace(await openGrants([path]), noKernel);
    expect((await workspace.load('block')).document.projectId).toBe(
      document.projectId
    );
    expect((await workspace.load(document.projectId)).document.name).toBe(
      'Block'
    );
    await expect(workspace.load(path)).rejects.toMatchObject({
      code: 'not_found'
    });
  });

  it('writes atomically, keeps the file mode and refuses a moved file', async () => {
    const document = blockDocument();
    const path = await project('block.openzcad', backupText(document));
    await chmod(path, 0o640);
    const workspace = new FileWorkspace(await openGrants([path]), noKernel);
    const loaded = await workspace.load('block');
    const featureNode = listFeaturesInOrder(loaded.document)[0]!;
    const renamed = new CommandManager(loaded.document).runTransaction(
      'Apply agent patch',
      [
        commandFactories.renameNode({
          nodeId: featureNode.id,
          name: 'Renamed block'
        })
      ]
    );
    const committed = await workspace.commit('block', loaded.revision, renamed);
    expect(committed.revision).not.toBe(loaded.revision);
    const written = JSON.parse(await readFile(path, 'utf8')) as {
      document: ProjectDocument;
    };
    expect(written.document.nodes[featureNode.id]?.name).toBe('Renamed block');
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.tmp'))
    ).toEqual([]);

    // Another writer replaces the file: the old revision no longer commits.
    await writeFile(path, backupText(blockDocument()));
    const before = await readFile(path);
    await expect(
      workspace.commit('block', committed.revision, renamed)
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await readFile(path)).toEqual(before);
  });
});

describe('openzcad-mcp network guard', () => {
  it('turns any fetch into a refusal', async () => {
    const saved = globalThis.fetch;
    const savedSocket = globalThis.WebSocket;
    try {
      installNetworkGuard();
      await expect(fetch('https://example.invalid/')).rejects.toThrow(
        /no network requests/
      );
    } finally {
      globalThis.fetch = saved;
      globalThis.WebSocket = savedSocket;
    }
  });
});
