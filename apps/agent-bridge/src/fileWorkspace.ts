import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink
} from 'node:fs/promises';
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

/**
 * Resolves and checks each granted path. The file must be a regular file
 * within the backup size limit and, on POSIX systems, owned by the user
 * running the server and writable by nobody else: the server's authority is
 * the launching user's, so it refuses a file another account could swap.
 */
export async function openGrants(
  paths: readonly string[]
): Promise<ProjectGrant[]> {
  const taken = new Set<string>();
  const seen = new Set<string>();
  const grants: ProjectGrant[] = [];
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const requested of paths) {
    let path: string;
    try {
      path = await realpath(requested);
    } catch {
      throw new Error(`Cannot open granted project ${requested}.`);
    }
    if (seen.has(path)) continue;
    seen.add(path);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`${requested} is not a file.`);
    if (info.size > MAX_PROJECT_BACKUP_BYTES)
      throw new Error(`${requested} is larger than the 256 MB backup limit.`);
    if (uid !== null) {
      if (info.uid !== uid)
        throw new Error(
          `${requested} belongs to another user. Grant only your own project files.`
        );
      if ((info.mode & 0o022) !== 0)
        throw new Error(
          `${requested} is writable by other users. Remove group and other write permission first (chmod go-w).`
        );
    }
    grants.push({ alias: aliasFor(path, taken), path });
  }
  return grants;
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
    let bytes: Uint8Array;
    try {
      bytes = await readFile(grant.path);
    } catch {
      throw new AgentToolError(
        'not_found',
        `The project file for "${grant.alias}" can no longer be read.`
      );
    }
    if (bytes.length > MAX_PROJECT_BACKUP_BYTES)
      throw new AgentToolError(
        'too_large',
        `The project file for "${grant.alias}" is larger than 256 MB.`
      );
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
    signal: AbortSignal
  ): Promise<ProjectDocument['derived']> {
    const adapter = await this.kernel();
    return adapter.syncDocument(document, undefined, undefined, analysis, {
      cancellation: { isCancelled: () => signal.aborted }
    });
  }

  async commit(
    project: string,
    revision: string,
    next: ProjectDocument
  ): Promise<LoadedProject> {
    const grant = await this.grantFor(project);
    const current = this.parsed.get(grant.alias);
    const onDisk = sha256(await readFile(grant.path));
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
    if (sha256(await readFile(grant.path)) !== revision) {
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
