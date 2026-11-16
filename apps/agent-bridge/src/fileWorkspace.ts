import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  AgentToolError,
  type AgentProjectSummary,
  type AgentWorkspace,
  type LoadedProject
} from '@openzcad/agent-api';
import {
  normalizeDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type {
  EditAnalysisRequest,
  ImportedSourceReference,
  ProjectDocument
} from '@openzcad/shared';
import {
  MAX_PROJECT_BACKUP_BYTES,
  backupFileBytes,
  parseProjectBackup,
  type ProjectBackup
} from '../../web/src/lib/projectBackup';

/** One project file the user granted on the command line. */
export interface ProjectGrant {
  alias: string;
  /** Resolved through symlinks once, at startup. */
  path: string;
}

function aliasFor(path: string, taken: Set<string>): string {
  const stem =
    basename(path)
      .replace(/\.openzcad$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project';
  let alias = stem;
  for (let suffix = 2; taken.has(alias); suffix += 1)
    alias = `${stem}-${suffix}`;
  taken.add(alias);
  return alias;
}

function currentUser(): { uid: number; gid: number } | null {
  return typeof process.getuid === 'function' &&
    typeof process.getgid === 'function'
    ? { uid: process.getuid(), gid: process.getgid() }
    : null;
}

/**
 * Why a granted file is unsafe for this server to act on, or null. On POSIX
 * systems the file must be owned by the user running the server and
 * writable by nobody else: the server acts with that user's authority, so it
 * refuses a file another account could change underneath it.
 */
export function grantedFileProblem(info: Stats, label: string): string | null {
  if (!info.isFile()) return `${label} is not a file.`;
  if (info.size > MAX_PROJECT_BACKUP_BYTES)
    return `${label} is larger than the 256 MB backup limit.`;
  const user = currentUser();
  if (!user) return null;
  if (info.uid !== user.uid)
    return `${label} belongs to another user. Grant only your own project files.`;
  if ((info.mode & 0o022) !== 0)
    return `${label} is writable by other users. Remove group and other write permission first (chmod go-w).`;
  return null;
}

/**
 * Why the folder holding a granted file is unsafe, or null. Whoever can write
 * the folder can replace the file in it — with another file or a link to
 * one — unless the sticky bit reserves that to the file's owner. A folder
 * writable by its group is accepted only when that group is the user's own
 * primary group (the usual private-group setup).
 */
export function grantFolderProblem(info: Stats, label: string): string | null {
  const user = currentUser();
  if (!user || (info.mode & 0o1000) !== 0) return null;
  if (
    (info.mode & 0o002) !== 0 ||
    ((info.mode & 0o020) !== 0 && info.gid !== user.gid)
  )
    return `The folder holding ${label} is writable by other users, who could replace the file. Move it to a folder only you can write.`;
  return null;
}

/**
 * Resolves and checks each granted path, once, at startup. Every later read
 * and write checks the grant again (see `FileWorkspace`), so a file replaced
 * or loosened after startup is refused rather than followed.
 */
export async function openGrants(
  paths: readonly string[]
): Promise<ProjectGrant[]> {
  const taken = new Set<string>();
  const seen = new Set<string>();
  const grants: ProjectGrant[] = [];
  for (const requested of paths) {
    let path: string;
    try {
      path = await realpath(requested);
    } catch {
      throw new Error(`Cannot open granted project ${requested}.`);
    }
    if (seen.has(path)) continue;
    seen.add(path);
    const problem =
      grantedFileProblem(await stat(path), requested) ??
      grantFolderProblem(await stat(dirname(path)), requested);
    if (problem) throw new Error(problem);
    grants.push({ alias: aliasFor(path, taken), path });
  }
  return grants;
}

/**
 * Reads a granted file only if it is still the file that was granted: the
 * path must still resolve to itself (no component replaced by a link), the
 * final component is opened without following a link, and the opened file
 * and its folder pass the startup checks again.
 */
async function readGranted(grant: ProjectGrant): Promise<Uint8Array> {
  const gone = () =>
    new AgentToolError(
      'not_found',
      `The project file for "${grant.alias}" was moved, replaced by a link or can no longer be read. Grant it again.`
    );
  const resolved = await realpath(grant.path).catch(() => null);
  if (resolved !== grant.path) throw gone();
  const folder = grantFolderProblem(
    await stat(dirname(grant.path)),
    `"${grant.alias}"`
  );
  if (folder) throw new AgentToolError('refused', folder);
  const handle = await open(
    grant.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  ).catch(() => {
    throw gone();
  });
  try {
    const problem = grantedFileProblem(
      await handle.stat(),
      `The project file for "${grant.alias}"`
    );
    if (problem) throw new AgentToolError('refused', problem);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface ParsedProject {
  revision: string;
  backup: ProjectBackup;
  document: ProjectDocument;
}

/**
 * Phase 1's workspace: granted `.openzcad` backups on the user's disk, the
 * exact kernel in this process. It reads the file again on every call, so an
 * edit made elsewhere is seen at once and a stale apply is refused.
 */
export class FileWorkspace implements AgentWorkspace {
  private readonly parsed = new Map<string, ParsedProject>();
  private adapter: Promise<ExactKernelAdapter> | null = null;

  constructor(
    private readonly grants: readonly ProjectGrant[],
    private readonly createAdapter: (
      resolveSourceBytes: (
        ref: ImportedSourceReference,
        context: { artifactId: string; sourceName: string }
      ) => Promise<Uint8Array>
    ) => Promise<ExactKernelAdapter>
  ) {}

  async projects(): Promise<readonly AgentProjectSummary[]> {
    const summaries: AgentProjectSummary[] = [];
    for (const grant of this.grants) {
      const { document } = await this.read(grant);
      summaries.push({
        alias: grant.alias,
        projectId: document.projectId,
        name: document.name,
        units: document.units,
        version: document.version,
        schemaVersion: document.schemaVersion
      });
    }
    return summaries;
  }

  private async grantFor(project: string): Promise<ProjectGrant> {
    const byAlias = this.grants.find((grant) => grant.alias === project);
    if (byAlias) return byAlias;
    for (const grant of this.grants) {
      const { document } = await this.read(grant);
      if (document.projectId === project) return grant;
    }
    throw new AgentToolError(
      'not_found',
      `No granted project is called "${project.slice(0, 100)}". list_projects names them.`
    );
  }

  private async read(grant: ProjectGrant): Promise<ParsedProject> {
    const bytes = await readGranted(grant);
    const revision = sha256(bytes);
    const known = this.parsed.get(grant.alias);
    if (known?.revision === revision) return known;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    // A plaintext backup is a JSON object. An ADR-024 envelope, an archive
    // or any other binary is refused by shape before it is parsed: this
    // server holds no key and must never be pointed at ciphertext.
    if (!/^\s*\{/.test(text))
      throw new AgentToolError(
        'invalid',
        `"${grant.alias}" is not a plaintext OpenZCAD project backup. Export the project from OpenZCAD (File → Export project) and grant that file.`
      );
    let backup: ProjectBackup;
    try {
      backup = await parseProjectBackup(text);
    } catch (error) {
      throw new AgentToolError(
        'invalid',
        `"${grant.alias}" is not a readable OpenZCAD project backup: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }
    const document = withoutDerivedProjection(
      normalizeDocument(backup.document)
    );
    const parsed = { revision, backup, document };
    this.parsed.set(grant.alias, parsed);
    return parsed;
  }

  async load(project: string): Promise<LoadedProject> {
    const { document, revision } = await this.read(
      await this.grantFor(project)
    );
    return { document, revision };
  }

  private kernel(): Promise<ExactKernelAdapter> {
    this.adapter ??= this.createAdapter(
      async (ref, { sourceName, artifactId }) => {
        for (const { backup } of this.parsed.values()) {
          const source = backup.sources?.find(
            (entry) => entry.sha256 === ref.checksumSha256
          );
          if (source) return backupFileBytes(source);
          const file = backup.files.find(
            (entry) =>
              entry.artifact.artifactId === artifactId &&
              entry.sha256 === ref.checksumSha256
          );
          if (file) return backupFileBytes(file);
        }
        throw Object.assign(
          new Error(
            `The project backup is missing the source of ${sourceName}.`
          ),
          { permanent: true }
        );
      }
    );
    return this.adapter;
  }

  async derive(
    document: ProjectDocument,
    analysis: EditAnalysisRequest | undefined,
    cancelled: () => boolean
  ): Promise<ProjectDocument['derived']> {
    const adapter = await this.kernel();
    return adapter.syncDocument(document, undefined, undefined, analysis, {
      cancellation: { isCancelled: cancelled }
    });
  }

  async commit(
    project: string,
    revision: string,
    next: ProjectDocument
  ): Promise<LoadedProject> {
    const grant = await this.grantFor(project);
    const current = this.parsed.get(grant.alias);
    const onDisk = sha256(await readGranted(grant));
    if (!current || current.revision !== revision || onDisk !== revision)
      throw new AgentToolError(
        'conflict',
        `The project file for "${grant.alias}" changed while the patch was checked. Nothing was written; read it again.`
      );
    const document = withoutDerivedProjection(next);
    const text = JSON.stringify({ ...current.backup, document });
    // Never write a file the app's own importer would refuse.
    const backup = await parseProjectBackup(text);
    const bytes = new TextEncoder().encode(text);
    const mode = (await stat(grant.path)).mode & 0o777;
    const temporary = join(
      dirname(grant.path),
      `.${basename(grant.path)}.${randomUUID()}.tmp`
    );
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      mode
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    // The last moment to notice a concurrent writer before replacing it.
    if (sha256(await readGranted(grant)) !== revision) {
      await unlink(temporary).catch(() => undefined);
      throw new AgentToolError(
        'conflict',
        `The project file for "${grant.alias}" changed while the patch was written. Nothing was written; read it again.`
      );
    }
    await rename(temporary, grant.path);
    try {
      const directory = await open(dirname(grant.path), constants.O_RDONLY);
      await directory.sync().finally(() => directory.close());
    } catch {
      // Directory fsync is not available on every platform.
    }
    const written = sha256(bytes);
    const parsed = { revision: written, backup, document };
    this.parsed.set(grant.alias, parsed);
    return { document, revision: written };
  }

  async dispose(): Promise<void> {
    const adapter = await this.adapter;
    adapter?.dispose();
  }
}
