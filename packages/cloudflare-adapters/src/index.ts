import { DurableObject } from 'cloudflare:workers';
import {
  ArtifactStorageError,
  getInMemoryPersistence,
  ProjectNotFoundError,
  RevisionConflictError,
  UPLOAD_SESSION_TTL_MS,
  type PersistenceService
} from '@openzcad/persistence';
import {
  nowIso,
  sanitizeFileName,
  toArtifactId,
  toUploadSessionId,
  type ArtifactMetadataResponse,
  type ArtifactRecord,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type CreateUploadSessionRequest,
  type CreateUploadSessionResponse,
  type CollaborationClientMessage,
  type CollaborationErrorCode,
  type CollaborationMember,
  type CollaborationServerMessage,
  type FinalizeArtifactRequest,
  type ListArtifactsResponse,
  type ListProjectsResponse,
  type ProjectDocument,
  type SaveRevisionRequest,
  type UploadSessionRecord,
  type UserId
} from '@openzcad/shared';
import {
  createCheckpoint,
  createProjectDocument,
  normalizeDocument
} from '@openzcad/document-core';

export interface CloudflareEnv {
  ENVIRONMENT?: 'development' | 'beta';
  AUTH_MODE?: 'development' | 'email-code';
  PRODUCTION_GUARD?: string;
  AUTH_LEGACY_OWNER_EMAIL?: string;
  AUTH_OTP_PEPPER?: string;
  AUTH_EMAIL_FROM?: string;
  AUTH_SESSION_DAYS?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  EMAIL?: SendEmail;
  AI_PROVIDER?: 'openai' | 'openrouter' | 'responses-compatible';
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  /** Backward-compatible OpenAI-specific secret name. */
  OPENAI_API_KEY?: string;
  /** OpenRouter-specific secret used when AI_PROVIDER=openrouter. */
  OPENROUTER_API_KEY?: string;
  /** Optional public app URL sent to OpenRouter for attribution. */
  AI_SITE_URL?: string;
  /** Optional app name sent to OpenRouter; defaults to OpenZCAD. */
  AI_APP_NAME?: string;
  AI_MODEL?: string;
  AI_REASONING_EFFORT?: 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * Output ceiling for one proposal. Reasoning tokens count against this, so it
   * must stay well clear of a full multi-part patch or the model truncates.
   */
  AI_MAX_OUTPUT_TOKENS?: string;
  AI_TIMEOUT_MS?: string;
  /** Base64-encoded 32-byte AES key for owner-scoped AI credentials. */
  SETTINGS_ENCRYPTION_KEY?: string;
  DB?: D1Database;
  ARTIFACTS?: R2Bucket;
}

export class D1R2PersistenceService implements PersistenceService {
  constructor(private readonly env: CloudflareEnv) {}

  async listProjects(userId: UserId): Promise<ListProjectsResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().listProjects(userId);
    }
    const rows = await this.env.DB.prepare(
      `SELECT id, name, updated_at, document_json FROM projects WHERE user_id = ? ORDER BY updated_at DESC`
    )
      .bind(userId)
      .all<{
        id: string;
        name: string;
        updated_at: string;
        document_json: string;
      }>();

    return {
      projects: (rows.results ?? []).flatMap(
        (row: {
          id: string;
          name: string;
          updated_at: string;
          document_json: string;
        }) => {
          try {
            const document = normalizeDocument(
              JSON.parse(row.document_json) as ProjectDocument
            );
            return [
              {
                projectId: document.projectId,
                name: row.name,
                lastRevisionId: document.revisions.at(-1)?.revisionId,
                revisionCount: document.revisions.length,
                updatedAt: row.updated_at
              }
            ];
          } catch {
            console.error('Skipping corrupt project row:', {
              projectId: row.id
            });
            return [];
          }
        }
      )
    };
  }

  async createProject(
    userId: UserId,
    request: CreateProjectRequest
  ): Promise<CreateProjectResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().createProject(userId, request);
    }
    const document = createProjectDocument(request.name, userId, request.units);
    await this.env.DB.prepare(
      `INSERT INTO projects (id, user_id, name, document_json, document_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        document.projectId,
        userId,
        document.name,
        JSON.stringify(document),
        document.version,
        nowIso()
      )
      .run();

    return {
      project: {
        projectId: document.projectId,
        name: document.name,
        lastRevisionId: document.revisions.at(-1)?.revisionId,
        revisionCount: document.revisions.length,
        updatedAt: nowIso()
      },
      document
    };
  }

  async loadProject(
    userId: UserId,
    projectId: string
  ): Promise<ProjectDocument | null> {
    if (!this.env.DB) {
      return getInMemoryPersistence().loadProject(userId, projectId);
    }
    const row = await this.env.DB.prepare(
      `SELECT document_json FROM projects WHERE id = ? AND user_id = ?`
    )
      .bind(projectId, userId)
      .first<{ document_json: string }>();
    return row
      ? normalizeDocument(JSON.parse(row.document_json) as ProjectDocument)
      : null;
  }

  async saveRevision(
    userId: UserId,
    request: SaveRevisionRequest
  ): Promise<ProjectDocument> {
    if (!this.env.DB) {
      return getInMemoryPersistence().saveRevision(userId, request);
    }
    const normalized = normalizeDocument(request.document);
    if (normalized.ownerUserId !== userId) {
      throw new ProjectNotFoundError(request.projectId);
    }
    const document = createCheckpoint(normalized, request.reason);
    const documentJson = JSON.stringify(document);
    const latestRevision = document.revisions.at(-1);
    if (!latestRevision) {
      throw new Error('Checkpoint creation did not produce a revision.');
    }
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE projects SET document_json = ?, document_version = ?, updated_at = ?, name = ? WHERE id = ? AND user_id = ? AND document_version = ?`
      ).bind(
        documentJson,
        document.version,
        nowIso(),
        document.name,
        request.projectId,
        userId,
        request.expectedVersion
      ),
      this.env.DB.prepare(
        `INSERT OR REPLACE INTO revisions (id, project_id, reason, document_json, created_at) SELECT ?, ?, ?, ?, ? WHERE changes() > 0`
      ).bind(
        latestRevision.revisionId,
        request.projectId,
        request.reason,
        documentJson,
        latestRevision.createdAt
      )
    ]);
    if (results[0]?.meta?.changes === 0) {
      const current = await this.env.DB.prepare(
        `SELECT document_version FROM projects WHERE id = ? AND user_id = ?`
      )
        .bind(request.projectId, userId)
        .first<{ document_version: number }>();
      if (!current) {
        throw new ProjectNotFoundError(request.projectId);
      }
      throw new RevisionConflictError(
        request.projectId,
        current.document_version
      );
    }
    return document;
  }

  async createUploadSession(
    userId: UserId,
    request: CreateUploadSessionRequest
  ): Promise<CreateUploadSessionResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().createUploadSession(userId, request);
    }
    await this.assertProjectOwner(userId, request.projectId);
    if (!this.env.ARTIFACTS) {
      throw new ArtifactStorageError();
    }
    await this.pruneExpiredUploads();
    const session = createUploadSessionRecord(request);
    await this.env.DB.prepare(
      `INSERT INTO upload_sessions (id, artifact_id, project_id, object_key, file_name, content_type, kind, metadata_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        session.uploadSessionId,
        session.artifactId,
        request.projectId,
        session.objectKey,
        session.fileName,
        session.contentType,
        session.kind,
        JSON.stringify(session.metadata),
        session.expiresAt
      )
      .run();
    return { session };
  }

  async putUpload(
    userId: UserId,
    uploadSessionId: string,
    body: ArrayBuffer
  ): Promise<void> {
    if (!this.env.DB) {
      return getInMemoryPersistence().putUpload(userId, uploadSessionId, body);
    }
    const upload = await this.env.DB.prepare(
      `SELECT u.object_key, u.content_type, u.expires_at FROM upload_sessions u INNER JOIN projects p ON p.id = u.project_id WHERE u.id = ? AND p.user_id = ?`
    )
      .bind(uploadSessionId, userId)
      .first<{
        object_key: string;
        content_type: string;
        expires_at: string;
      }>();
    if (!upload || Date.parse(upload.expires_at) < Date.now()) {
      throw new ArtifactStorageError(
        'Upload session was not found or expired.'
      );
    }
    if (!this.env.ARTIFACTS) {
      throw new ArtifactStorageError();
    }
    await this.env.ARTIFACTS.put(upload.object_key, body, {
      httpMetadata: { contentType: upload.content_type }
    });
  }

  async finalizeArtifact(
    userId: UserId,
    request: FinalizeArtifactRequest
  ): Promise<ArtifactRecord | null> {
    if (!this.env.DB) {
      return getInMemoryPersistence().finalizeArtifact(userId, request);
    }
    await this.assertProjectOwner(userId, request.projectId);
    const upload = await this.env.DB.prepare(
      `SELECT artifact_id, object_key, project_id, file_name, content_type, kind, metadata_json, expires_at FROM upload_sessions WHERE id = ?`
    )
      .bind(request.uploadSessionId)
      .first<{
        artifact_id: string;
        object_key: string;
        project_id: string;
        file_name: string;
        content_type: string;
        kind: ArtifactRecord['kind'];
        metadata_json: string;
        expires_at: string;
      }>();
    if (
      !upload ||
      upload.project_id !== request.projectId ||
      upload.artifact_id !== request.artifactId ||
      Date.parse(upload.expires_at) < Date.now()
    ) {
      return null;
    }
    if (!this.env.ARTIFACTS) {
      throw new ArtifactStorageError();
    }
    const stored = await this.env.ARTIFACTS.head(upload.object_key);
    if (!stored) {
      return null;
    }

    const artifact: ArtifactRecord = {
      artifactId: request.artifactId,
      projectId: request.projectId,
      kind: upload.kind,
      name: upload.file_name,
      objectKey: upload.object_key,
      contentType: upload.content_type,
      bytes: stored.size,
      createdAt: nowIso(),
      metadata: JSON.parse(upload.metadata_json) as ArtifactRecord['metadata']
    };

    await this.env.DB.batch([
      this.env.DB.prepare(
        `DELETE FROM upload_sessions WHERE id = ? AND artifact_id = ?`
      ).bind(request.uploadSessionId, request.artifactId),
      this.env.DB.prepare(
        `INSERT INTO artifacts (id, project_id, kind, name, object_key, content_type, bytes, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        artifact.artifactId,
        artifact.projectId,
        artifact.kind,
        artifact.name,
        artifact.objectKey,
        artifact.contentType,
        artifact.bytes,
        JSON.stringify(artifact.metadata),
        artifact.createdAt
      )
    ]);

    return artifact;
  }

  async listArtifacts(
    userId: UserId,
    projectId: string
  ): Promise<ListArtifactsResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().listArtifacts(userId, projectId);
    }
    await this.assertProjectOwner(userId, projectId);
    const rows = await this.env.DB.prepare(
      `SELECT id, project_id, kind, name, object_key, content_type, bytes, metadata_json, created_at FROM artifacts WHERE project_id = ? ORDER BY created_at DESC`
    )
      .bind(projectId)
      .all<ArtifactRow>();
    return { artifacts: (rows.results ?? []).map(artifactFromRow) };
  }

  async getArtifactMetadata(
    userId: UserId,
    artifactId: string
  ): Promise<ArtifactMetadataResponse> {
    if (!this.env.DB) {
      return getInMemoryPersistence().getArtifactMetadata(userId, artifactId);
    }
    const row = await this.env.DB.prepare(
      `SELECT a.id, a.project_id, a.kind, a.name, a.object_key, a.content_type, a.bytes, a.metadata_json, a.created_at FROM artifacts a INNER JOIN projects p ON p.id = a.project_id WHERE a.id = ? AND p.user_id = ?`
    )
      .bind(artifactId, userId)
      .first<ArtifactRow>();

    return {
      artifact: row ? artifactFromRow(row) : null
    };
  }

  async downloadArtifact(
    userId: UserId,
    artifactId: string
  ): Promise<{ artifact: ArtifactRecord; body: ArrayBuffer } | null> {
    if (!this.env.DB) {
      return getInMemoryPersistence().downloadArtifact(userId, artifactId);
    }
    const { artifact } = await this.getArtifactMetadata(userId, artifactId);
    if (!artifact) {
      return null;
    }
    if (!this.env.ARTIFACTS) {
      throw new ArtifactStorageError();
    }
    const stored = await this.env.ARTIFACTS.get(artifact.objectKey);
    return stored ? { artifact, body: await stored.arrayBuffer() } : null;
  }

  private async assertProjectOwner(
    userId: UserId,
    projectId: string
  ): Promise<void> {
    const row = await this.env
      .DB!.prepare(`SELECT id FROM projects WHERE id = ? AND user_id = ?`)
      .bind(projectId, userId)
      .first<{ id: string }>();
    if (!row) {
      throw new ProjectNotFoundError(projectId);
    }
  }

  private async pruneExpiredUploads(): Promise<void> {
    if (!this.env.DB || !this.env.ARTIFACTS) {
      return;
    }
    const expired = await this.env.DB.prepare(
      `SELECT id, object_key FROM upload_sessions WHERE expires_at < ? LIMIT 100`
    )
      .bind(nowIso())
      .all<{ id: string; object_key: string }>();
    const rows = expired.results ?? [];
    if (rows.length === 0) {
      return;
    }
    await Promise.allSettled(
      rows.map((row) => this.env.ARTIFACTS!.delete(row.object_key))
    );
    await this.env.DB.batch(
      rows.map((row) =>
        this.env
          .DB!.prepare(`DELETE FROM upload_sessions WHERE id = ?`)
          .bind(row.id)
      )
    );
  }
}

function createUploadSessionRecord(
  request: CreateUploadSessionRequest
): UploadSessionRecord {
  const session: UploadSessionRecord = {
    uploadSessionId: toUploadSessionId(`upload_${crypto.randomUUID()}`),
    artifactId: toArtifactId(`artifact_${crypto.randomUUID()}`),
    projectId: request.projectId,
    objectKey: `${request.projectId}/uploads/${crypto.randomUUID()}-${sanitizeFileName(request.fileName)}`,
    fileName: request.fileName,
    contentType: request.contentType,
    kind: request.kind,
    metadata: request.metadata ?? {},
    expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_MS).toISOString()
  };
  session.uploadUrl = `/api/uploads/${session.uploadSessionId}/content`;
  return session;
}

interface ArtifactRow {
  id: string;
  project_id: string;
  kind: ArtifactRecord['kind'];
  name: string;
  object_key: string;
  content_type: string;
  bytes: number | null;
  metadata_json: string;
  created_at: string;
}

function artifactFromRow(row: ArtifactRow): ArtifactRecord {
  return {
    artifactId: row.id as ArtifactRecord['artifactId'],
    projectId: row.project_id as ArtifactRecord['projectId'],
    kind: row.kind,
    name: row.name,
    objectKey: row.object_key,
    contentType: row.content_type,
    ...(row.bytes === null ? {} : { bytes: row.bytes }),
    createdAt: row.created_at,
    metadata: JSON.parse(row.metadata_json) as ArtifactRecord['metadata']
  };
}

// Cache one service per env object (envs are stable per isolate) so schema
// setup memoization survives across requests without pinning a stale env.
const servicesByEnv = new WeakMap<CloudflareEnv, PersistenceService>();

export function createPersistenceService(
  env: CloudflareEnv
): PersistenceService {
  if (!env.DB) {
    return getInMemoryPersistence();
  }

  let service = servicesByEnv.get(env);
  if (!service) {
    service = new D1R2PersistenceService(env);
    servicesByEnv.set(env, service);
  }
  return service;
}

/** Keys under which one room's state lives; see {@link RoomMeta}. */
const ROOM_META_KEY = 'room:meta';
const ROOM_LATEST_KEY = 'room:latest';
const ROOM_HISTORY_PREFIX = 'room:history:';
/** Pre-split layout: the whole room under one value. Migrated away on load. */
const LEGACY_ROOM_STATE_KEY = 'room-state';
const ROOM_STORAGE_SCHEMA = 1;
const MAX_ROOM_HISTORY = 20;

/**
 * Ceiling for any document the room stores. SQLite-backed Durable Object
 * storage rejects a single value over 2 MiB, and every document now occupies a
 * key of its own, so this is the real limit rather than a guess at how far the
 * whole room may grow. Documents above it are refused before any in-memory
 * state moves, because a write that fails after the mutation leaves the room
 * serving state that no longer survives eviction.
 */
const MAX_PERSISTED_DOCUMENT_BYTES = 1_500_000;

/**
 * Structural limits applied to client JSON before it reaches `normalizeDocument`
 * or the three-way merge, both of which recurse without a depth guard.
 */
const MAX_CLIENT_DOCUMENT_DEPTH = 64;
const MAX_CLIENT_DOCUMENT_VALUES = 500_000;

/** Largest HTTP snapshot body accepted, sized to fit one storable document. */
const MAX_SNAPSHOT_PAYLOAD_BYTES = 1_600_000;

interface RoomMeta {
  schema: number;
  projectId: string | null;
  latestVersion: number | null;
  historyVersions: number[];
}

interface LegacyRoomState {
  projectId: string | null;
  latestDocument: ProjectDocument | null;
  history?: ProjectDocument[];
}

interface RoomStorage {
  get<T>(key: string): Promise<T | undefined>;
  put: {
    <T>(key: string, value: T): Promise<void>;
    (entries: Record<string, unknown>): Promise<void>;
  };
  delete: {
    (key: string): Promise<boolean>;
    (keys: string[]): Promise<number>;
  };
}

function historyKey(version: number): string {
  return `${ROOM_HISTORY_PREFIX}${version}`;
}

export class ProjectCollaborationRoom extends DurableObject {
  private readonly roomContext: {
    storage: RoomStorage;
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  };
  private readonly ready: Promise<void>;
  private presence = new Map<string, string>();
  private locks = new Map<string, string>();
  private sockets = new Map<
    WebSocket,
    { clientId: string; userId: UserId; displayName: string }
  >();
  private latestDocument: ProjectDocument | null = null;
  private documentHistory = new Map<number, ProjectDocument>();
  private projectId: string | null = null;

  constructor(ctx: unknown, env: unknown) {
    super(ctx, env);
    this.roomContext = ctx as typeof this.roomContext;
    this.ready = this.roomContext.blockConcurrencyWhile(async () => {
      await this.migrateLegacyRoomState();
      const meta = await this.roomContext.storage.get<RoomMeta>(ROOM_META_KEY);
      if (!meta) {
        return;
      }
      this.projectId = meta.projectId ?? null;
      this.latestDocument =
        (await this.roomContext.storage.get<ProjectDocument>(
          ROOM_LATEST_KEY
        )) ?? null;
      const history = await Promise.all(
        (meta.historyVersions ?? []).map((version) =>
          this.roomContext.storage.get<ProjectDocument>(historyKey(version))
        )
      );
      for (const document of history) {
        if (document) {
          this.documentHistory.set(document.version, document);
        }
      }
    });
  }

  /**
   * Rewrites a pre-split `room-state` value into one key per document. The
   * legacy key is dropped only once the replacement keys are committed, so an
   * interrupted migration re-runs from the original on the next load.
   */
  private async migrateLegacyRoomState(): Promise<void> {
    const legacy =
      await this.roomContext.storage.get<LegacyRoomState>(
        LEGACY_ROOM_STATE_KEY
      );
    if (!legacy) {
      return;
    }
    const alreadySplit =
      await this.roomContext.storage.get<RoomMeta>(ROOM_META_KEY);
    if (!alreadySplit) {
      const history = (legacy.history ?? []).slice(-MAX_ROOM_HISTORY);
      const entries: Record<string, unknown> = {};
      for (const document of history) {
        entries[historyKey(document.version)] = document;
      }
      if (legacy.latestDocument) {
        entries[ROOM_LATEST_KEY] = legacy.latestDocument;
      }
      entries[ROOM_META_KEY] = {
        schema: ROOM_STORAGE_SCHEMA,
        projectId: legacy.projectId ?? null,
        latestVersion: legacy.latestDocument?.version ?? null,
        historyVersions: history
          .map((document) => document.version)
          .sort((left, right) => left - right)
      } satisfies RoomMeta;
      await this.roomContext.storage.put(entries);
    }
    await this.roomContext.storage.delete(LEGACY_ROOM_STATE_KEY);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (request.method === 'POST') {
      return this.acceptHttpSnapshot(request);
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required.', { status: 426 });
    }
    const userId = request.headers.get('x-openzcad-user-id');
    const displayName = request.headers.get('x-openzcad-display-name');
    const projectId = new URL(request.url).searchParams.get('projectId');
    if (!userId || !displayName || !projectId) {
      return new Response('Missing collaboration identity.', { status: 400 });
    }
    if (this.projectId && this.projectId !== projectId) {
      return new Response('Room project mismatch.', { status: 409 });
    }
    if (this.projectId !== projectId) {
      this.projectId = projectId;
      await this.persistRoomState();
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.addEventListener(
      'message',
      (event: MessageEvent<string | ArrayBuffer>) => {
        // Nothing awaits this handler, so a rejection here would surface as an
        // unhandled rejection and the sender would wait forever for an ack.
        void this.handleSocketMessage(
          server,
          event.data,
          userId as UserId,
          displayName
        ).catch((error: unknown) => {
          console.error('Collaboration message handling failed.', error);
          this.send(server, {
            type: 'error',
            code: 'internal',
            message: 'The collaboration room could not process that message.'
          });
        });
      }
    );
    const close = () => this.removeSocket(server);
    server.addEventListener('close', close);
    server.addEventListener('error', close);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleSocketMessage(
    socket: WebSocket,
    raw: string | ArrayBuffer,
    userId: UserId,
    displayName: string
  ): Promise<void> {
    if (typeof raw !== 'string' || raw.length > 950_000) {
      socket.close(1009, 'Collaboration message is too large.');
      return;
    }
    let message: CollaborationClientMessage;
    try {
      message = JSON.parse(raw) as CollaborationClientMessage;
    } catch {
      socket.close(1003, 'Invalid collaboration message.');
      return;
    }
    if (!message.clientId) {
      return;
    }

    if (message.type === 'hello') {
      this.sockets.set(socket, {
        clientId: message.clientId,
        userId,
        displayName
      });
      this.presence.set(message.clientId, 'active');
      if (message.document) {
        await this.acceptDocument(
          socket,
          message.clientId,
          message.document,
          message.baseVersion,
          false
        );
      }
      this.send(socket, {
        type: 'state',
        members: this.members(),
        document: this.latestDocument
      });
      this.broadcastPresence();
      return;
    }
    const connection = this.sockets.get(socket);
    if (!connection || connection.clientId !== message.clientId) {
      socket.close(1008, 'Collaboration client identity changed.');
      return;
    }
    if (message.type === 'presence') {
      this.presence.set(message.clientId, message.status);
      this.broadcastPresence();
      return;
    }
    if (message.type === 'document') {
      await this.acceptDocument(
        socket,
        message.clientId,
        message.document,
        message.baseVersion,
        true
      );
    }
  }

  private async acceptDocument(
    socket: WebSocket,
    clientId: string,
    rawDocument: ProjectDocument,
    baseVersion: number | null,
    broadcast: boolean
  ): Promise<void> {
    const rejection = checkClientDocument(rawDocument);
    if (rejection) {
      this.send(socket, { type: 'error', ...rejection });
      return;
    }
    const document = normalizeDocument(rawDocument);
    if (document.projectId !== this.projectId) {
      socket.close(1008, 'Document project does not match this room.');
      return;
    }
    const latest = this.latestDocument;
    const base =
      baseVersion === null ? undefined : this.documentHistory.get(baseVersion);
    const resolution = resolveCollaborationDocument(latest, document, base);
    if (resolution.kind === 'accept') {
      const oversize = checkPersistedSize(resolution.document);
      if (oversize) {
        this.send(socket, { type: 'error', ...oversize });
        return;
      }
      await this.commitDocument(resolution.document);
      // A merge produces a document the sender never had. The broadcast below
      // skips the sender, so the merged state has to ride along on the ack or
      // the sender stays silently divergent while reporting itself synced.
      this.send(socket, ackFor(resolution.document, document));
      if (broadcast) {
        this.broadcast(
          { type: 'document', clientId, document: resolution.document },
          socket
        );
      }
      return;
    }
    if (resolution.kind === 'conflict') {
      this.send(socket, { type: 'conflict', document: resolution.document });
    }
  }

  /**
   * Promotes a resolved document to latest and persists it. Callers check
   * {@link checkPersistedSize} first: in-memory state must not move ahead of
   * what storage will accept, or the room reverts to an older document the
   * next time it is evicted.
   */
  private async commitDocument(document: ProjectDocument): Promise<void> {
    const dirty = new Set<number>();
    const previousLatest = this.latestDocument;
    const previousHistory = new Map(this.documentHistory);
    if (previousLatest && previousLatest.version !== document.version) {
      this.documentHistory.set(previousLatest.version, previousLatest);
      dirty.add(previousLatest.version);
    }
    this.latestDocument = document;
    this.documentHistory.set(document.version, document);
    dirty.add(document.version);
    try {
      await this.persistRoomState(dirty);
    } catch (error) {
      // A write that failed for any other reason must not leave the room
      // serving a document storage never took; the caller reports the failure.
      this.latestDocument = previousLatest;
      this.documentHistory = previousHistory;
      throw error;
    }
  }

  private async acceptHttpSnapshot(request: Request): Promise<Response> {
    const userId = request.headers.get('x-openzcad-user-id');
    const displayName = request.headers.get('x-openzcad-display-name');
    const projectId = new URL(request.url).searchParams.get('projectId');
    if (!userId || !displayName || !projectId) {
      return new Response('Missing collaboration identity.', { status: 400 });
    }
    const contentLength = Number(request.headers.get('content-length') ?? '0');
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_SNAPSHOT_PAYLOAD_BYTES
    ) {
      return oversizeSnapshotResponse();
    }
    // `content-length` is absent on chunked bodies, so the body itself is what
    // actually has to be measured before anything parses it.
    const body = await request.text();
    if (body.length > MAX_SNAPSHOT_PAYLOAD_BYTES) {
      return oversizeSnapshotResponse();
    }
    let payload: {
      clientId?: string;
      baseVersion?: number | null;
      document?: ProjectDocument;
    };
    try {
      payload = JSON.parse(body) as typeof payload;
    } catch {
      return new Response('Invalid collaboration snapshot.', { status: 400 });
    }
    if (!payload.clientId || !payload.document) {
      return new Response('Invalid collaboration snapshot.', { status: 400 });
    }
    if (this.projectId && this.projectId !== projectId) {
      return new Response('Room project mismatch.', { status: 409 });
    }
    const rejection = checkClientDocument(payload.document);
    if (rejection) {
      return rejectionResponse(rejection);
    }
    this.projectId = projectId;
    const document = normalizeDocument(payload.document);
    if (document.projectId !== projectId) {
      return new Response('Document project mismatch.', { status: 400 });
    }
    const resolution = resolveCollaborationDocument(
      this.latestDocument,
      document,
      payload.baseVersion === null || payload.baseVersion === undefined
        ? undefined
        : this.documentHistory.get(payload.baseVersion)
    );
    if (resolution.kind === 'conflict') {
      return Response.json(
        { type: 'conflict', document: resolution.document },
        { status: 409 }
      );
    }
    if (resolution.kind === 'accept') {
      const oversize = checkPersistedSize(resolution.document);
      if (oversize) {
        return rejectionResponse(oversize);
      }
      await this.commitDocument(resolution.document);
      this.broadcast({
        type: 'document',
        clientId: payload.clientId,
        document: resolution.document
      });
    }
    return Response.json(ackFor(resolution.document, document));
  }

  /**
   * Writes the room index plus whichever documents changed. Each document owns
   * a key, so no single value grows with history depth; `put` takes them as one
   * batch so the index never advertises a version its key is missing.
   */
  private async persistRoomState(
    dirtyHistoryVersions: ReadonlySet<number> = new Set()
  ): Promise<void> {
    const evicted = this.trimHistory();
    const entries: Record<string, unknown> = {};
    for (const version of dirtyHistoryVersions) {
      const document = this.documentHistory.get(version);
      if (document) {
        entries[historyKey(version)] = document;
      }
    }
    if (this.latestDocument) {
      entries[ROOM_LATEST_KEY] = this.latestDocument;
    }
    entries[ROOM_META_KEY] = {
      schema: ROOM_STORAGE_SCHEMA,
      projectId: this.projectId,
      latestVersion: this.latestDocument?.version ?? null,
      historyVersions: Array.from(this.documentHistory.keys()).sort(
        (left, right) => left - right
      )
    } satisfies RoomMeta;
    await this.roomContext.storage.put(entries);
    // Deleting after the index no longer references these keys keeps a failed
    // delete a storage leak rather than a dangling history version.
    if (evicted.length > 0) {
      await this.roomContext.storage.delete(evicted.map(historyKey));
    }
  }

  /** Drops the oldest history entries, returning the versions to unlink. */
  private trimHistory(): number[] {
    const versions = Array.from(this.documentHistory.keys()).sort(
      (left, right) => left - right
    );
    const evicted = versions.slice(
      0,
      Math.max(0, versions.length - MAX_ROOM_HISTORY)
    );
    for (const version of evicted) {
      this.documentHistory.delete(version);
    }
    return evicted;
  }

  private members(): CollaborationMember[] {
    return Array.from(this.sockets.values()).map((connection) => ({
      clientId: connection.clientId,
      userId: connection.userId,
      displayName: connection.displayName,
      status:
        this.presence.get(connection.clientId) === 'idle' ? 'idle' : 'active'
    }));
  }

  private send(socket: WebSocket, message: CollaborationServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private broadcast(
    message: CollaborationServerMessage,
    except?: WebSocket
  ): void {
    for (const socket of this.sockets.keys()) {
      if (socket !== except) {
        this.send(socket, message);
      }
    }
  }

  private broadcastPresence(): void {
    this.broadcast({ type: 'presence', members: this.members() });
  }

  private removeSocket(socket: WebSocket): void {
    const connection = this.sockets.get(socket);
    if (!connection) {
      return;
    }
    this.sockets.delete(socket);
    this.presence.delete(connection.clientId);
    this.broadcastPresence();
  }

  async joinSession(userId: string, status: string) {
    this.presence.set(userId, status);
    return { members: Array.from(this.presence.entries()) };
  }

  async setLock(path: string, userId: string | null) {
    if (userId) {
      this.locks.set(path, userId);
    } else {
      this.locks.delete(path);
    }
    return { locks: Array.from(this.locks.entries()) };
  }

  async snapshot() {
    return {
      members: Array.from(this.presence.entries()),
      locks: Array.from(this.locks.entries())
    };
  }
}

interface CollaborationRejection {
  code: CollaborationErrorCode;
  message: string;
}

/** Carries a refusal on the HTTP path in the same shape sockets receive. */
function rejectionResponse(rejection: CollaborationRejection): Response {
  return Response.json(
    { type: 'error', ...rejection } satisfies CollaborationServerMessage,
    { status: rejection.code === 'document-invalid' ? 400 : 413 }
  );
}

function oversizeSnapshotResponse(): Response {
  return rejectionResponse({
    code: 'document-too-large',
    message: 'Collaboration snapshot is too large to store.'
  });
}

/**
 * Screens client JSON before `normalizeDocument` and the three-way merge walk
 * it. Both recurse, so a deeply nested payload would throw a RangeError out of
 * a path with no natural place to report it. The walk here is iterative for the
 * same reason.
 */
function checkClientDocument(value: unknown): CollaborationRejection | null {
  if (!isRecord(value)) {
    return {
      code: 'document-invalid',
      message: 'Collaboration document must be an object.'
    };
  }
  let visited = 0;
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 1 }
  ];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (entry.depth > MAX_CLIENT_DOCUMENT_DEPTH) {
      return {
        code: 'document-too-complex',
        message: `Collaboration document nests deeper than ${MAX_CLIENT_DOCUMENT_DEPTH} levels.`
      };
    }
    visited += 1;
    if (visited > MAX_CLIENT_DOCUMENT_VALUES) {
      return {
        code: 'document-too-complex',
        message: `Collaboration document holds more than ${MAX_CLIENT_DOCUMENT_VALUES} values.`
      };
    }
    const current = entry.value;
    if (Array.isArray(current)) {
      for (const item of current) {
        pending.push({ value: item, depth: entry.depth + 1 });
      }
    } else if (isRecord(current)) {
      for (const item of Object.values(current)) {
        pending.push({ value: item, depth: entry.depth + 1 });
      }
    }
  }
  return null;
}

const documentEncoder = new TextEncoder();

/** Rejects a document that would not fit in one durable-storage value. */
function checkPersistedSize(
  document: ProjectDocument
): CollaborationRejection | null {
  const bytes = documentEncoder.encode(JSON.stringify(document)).byteLength;
  return bytes > MAX_PERSISTED_DOCUMENT_BYTES
    ? {
        code: 'document-too-large',
        message: `Collaboration document is ${bytes} bytes; the room stores at most ${MAX_PERSISTED_DOCUMENT_BYTES}.`
      }
    : null;
}

/**
 * Builds the acknowledgement for an accepted submission.
 *
 * The resolved document only reaches other clients through a broadcast that
 * skips the sender, so whenever resolution produced something other than what
 * the sender submitted it has to travel back on the ack. A differing version is
 * exactly that signal: `accept` hands back the submitted document unchanged,
 * `same` hands back a content-identical document at the same version, and only
 * a merge mints a new version.
 */
function ackFor(
  resolved: ProjectDocument,
  submitted: ProjectDocument
): CollaborationServerMessage {
  return resolved.version === submitted.version
    ? { type: 'ack', version: resolved.version }
    : { type: 'ack', version: resolved.version, document: resolved };
}

export function resolveCollaborationDocument(
  latest: ProjectDocument | null,
  incoming: ProjectDocument,
  base?: ProjectDocument
):
  | { kind: 'accept'; document: ProjectDocument }
  | { kind: 'same'; document: ProjectDocument }
  | { kind: 'conflict'; document: ProjectDocument } {
  if (!latest) {
    return { kind: 'accept', document: incoming };
  }
  if (
    base &&
    base.projectId === latest.projectId &&
    base.projectId === incoming.projectId &&
    base.version < latest.version &&
    base.version < incoming.version
  ) {
    const merged = mergeCollaborationDocuments(base, latest, incoming);
    if (merged) {
      return { kind: 'accept', document: merged };
    }
  }
  if (incoming.version > latest.version) {
    return { kind: 'accept', document: incoming };
  }
  const sameHistory =
    incoming.version === latest.version &&
    JSON.stringify({
      nodes: incoming.nodes,
      featureOrder: incoming.featureOrder,
      bodyOrder: incoming.bodyOrder,
      sketchOrder: incoming.sketchOrder,
      parameterOrder: incoming.parameterOrder,
      commandLog: incoming.commandLog
    }) ===
      JSON.stringify({
        nodes: latest.nodes,
        featureOrder: latest.featureOrder,
        bodyOrder: latest.bodyOrder,
        sketchOrder: latest.sketchOrder,
        parameterOrder: latest.parameterOrder,
        commandLog: latest.commandLog
      });
  return sameHistory
    ? { kind: 'same', document: latest }
    : { kind: 'conflict', document: latest };
}

const MERGE_CONFLICT = Symbol('collaboration-merge-conflict');
type JsonMergeValue =
  | null
  | boolean
  | number
  | string
  | undefined
  | JsonMergeValue[]
  | { [key: string]: JsonMergeValue };

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasJsonPrefix(values: unknown[], prefix: unknown[]): boolean {
  return (
    values.length >= prefix.length &&
    prefix.every((value, index) => sameJson(value, values[index]))
  );
}

function mergeJsonValue(
  base: unknown,
  latest: unknown,
  incoming: unknown
): JsonMergeValue | typeof MERGE_CONFLICT {
  if (sameJson(latest, incoming)) {
    return structuredClone(latest) as JsonMergeValue;
  }
  if (sameJson(base, latest)) {
    return structuredClone(incoming) as JsonMergeValue;
  }
  if (sameJson(base, incoming)) {
    return structuredClone(latest) as JsonMergeValue;
  }
  if (Array.isArray(base) && Array.isArray(latest) && Array.isArray(incoming)) {
    if (!hasJsonPrefix(latest, base) || !hasJsonPrefix(incoming, base)) {
      return MERGE_CONFLICT;
    }
    const merged = structuredClone(latest) as JsonMergeValue[];
    for (const value of incoming.slice(base.length)) {
      if (!merged.some((candidate) => sameJson(candidate, value))) {
        merged.push(structuredClone(value) as JsonMergeValue);
      }
    }
    return merged;
  }
  if (isRecord(base) && isRecord(latest) && isRecord(incoming)) {
    const merged: { [key: string]: JsonMergeValue } = {};
    const keys = new Set([
      ...Object.keys(base),
      ...Object.keys(latest),
      ...Object.keys(incoming)
    ]);
    for (const key of keys) {
      const value = mergeJsonValue(base[key], latest[key], incoming[key]);
      if (value === MERGE_CONFLICT) {
        return MERGE_CONFLICT;
      }
      if (value !== undefined) {
        merged[key] = value;
      }
    }
    return merged;
  }
  return MERGE_CONFLICT;
}

export function mergeCollaborationDocuments(
  base: ProjectDocument,
  latest: ProjectDocument,
  incoming: ProjectDocument
): ProjectDocument | null {
  const withoutVolatileState = (document: ProjectDocument) => {
    const { version: _version, derived: _derived, ...stable } = document;
    return stable;
  };
  const merged = mergeJsonValue(
    withoutVolatileState(base),
    withoutVolatileState(latest),
    withoutVolatileState(incoming)
  );
  if (merged === MERGE_CONFLICT || !isRecord(merged)) {
    return null;
  }
  return normalizeDocument({
    ...merged,
    version: Math.max(latest.version, incoming.version) + 1,
    derived: {
      bodyRepresentations: {},
      exportableBodyIds: [],
      warnings: [],
      updatedAt: nowIso()
    }
  } as unknown as ProjectDocument);
}
