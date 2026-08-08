import type { StoredMeasurementRecord } from '../src/lib/measurementRecord';
import { parseStoredMeasurements } from '../src/lib/measurementStore';

/** Keeps a D1 row comfortably below the platform's per-row ceiling. */
export const MAX_PROJECT_MEASUREMENT_BYTES = 512 * 1024;

export interface ProjectMeasurementSnapshot {
  revision: number;
  record: StoredMeasurementRecord | null;
}

export interface SaveProjectMeasurementsInput {
  expectedRevision: number;
  record: StoredMeasurementRecord;
}

export class ProjectMeasurementRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`Project measurements are at revision ${currentRevision}.`);
    this.name = 'ProjectMeasurementRevisionConflictError';
  }
}

function measurementJson(record: StoredMeasurementRecord): string {
  const payload = JSON.stringify(record);
  if (
    new TextEncoder().encode(payload).byteLength > MAX_PROJECT_MEASUREMENT_BYTES
  ) {
    throw new ProjectMeasurementRequestError(
      413,
      `Measurements exceed the ${MAX_PROJECT_MEASUREMENT_BYTES}-byte cloud limit.`
    );
  }
  return payload;
}

export class ProjectMeasurementRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ProjectMeasurementRequestError';
  }
}

function requestRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectMeasurementRequestError(
      400,
      'Request body must be a JSON object.'
    );
  }
  return value as Record<string, unknown>;
}

export function parseSaveProjectMeasurementsRequest(
  body: unknown,
  projectId: string
): SaveProjectMeasurementsInput {
  const input = requestRecord(body);
  if (
    typeof input.expectedRevision !== 'number' ||
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    throw new ProjectMeasurementRequestError(
      400,
      '"expectedRevision" must be a non-negative integer.'
    );
  }
  const record = parseStoredMeasurements(input.record);
  if (!record || record.projectId !== projectId) {
    throw new ProjectMeasurementRequestError(
      400,
      'Measurements are malformed or belong to another project.'
    );
  }
  measurementJson(record);
  return { expectedRevision: input.expectedRevision, record };
}

export function parseDeleteProjectMeasurementsRequest(body: unknown): number {
  const input = requestRecord(body);
  if (
    typeof input.expectedRevision !== 'number' ||
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    throw new ProjectMeasurementRequestError(
      400,
      '"expectedRevision" must be a non-negative integer.'
    );
  }
  return input.expectedRevision;
}

interface ProjectMeasurementRow {
  payload_json: string;
  revision: number;
}

async function currentRevision(
  db: D1Database,
  projectId: string
): Promise<number> {
  const row = await db
    .prepare(`SELECT revision FROM project_measurements WHERE project_id = ?`)
    .bind(projectId)
    .first<{ revision: number }>();
  return row?.revision ?? 0;
}

export async function loadProjectMeasurements(
  db: D1Database,
  projectId: string
): Promise<ProjectMeasurementSnapshot> {
  const row = await db
    .prepare(
      `SELECT payload_json, revision
       FROM project_measurements
       WHERE project_id = ?`
    )
    .bind(projectId)
    .first<ProjectMeasurementRow>();
  if (!row) {
    return { revision: 0, record: null };
  }
  const parsed = parseStoredMeasurements(
    JSON.parse(row.payload_json) as unknown
  );
  if (!parsed || parsed.projectId !== projectId) {
    throw new Error('Stored project measurements are malformed.');
  }
  return { revision: row.revision, record: parsed };
}

export async function saveProjectMeasurements(
  db: D1Database,
  projectId: string,
  input: SaveProjectMeasurementsInput
): Promise<ProjectMeasurementSnapshot> {
  const payload = measurementJson(input.record);
  const nextRevision = input.expectedRevision + 1;
  const result =
    input.expectedRevision === 0
      ? await db
          .prepare(
            `INSERT INTO project_measurements
               (project_id, record_version, revision, payload_json, updated_at)
             VALUES (?, ?, 1, ?, ?)
             ON CONFLICT(project_id) DO NOTHING`
          )
          .bind(
            projectId,
            input.record.version,
            payload,
            input.record.updatedAt
          )
          .run()
      : await db
          .prepare(
            `UPDATE project_measurements
             SET record_version = ?, revision = ?, payload_json = ?, updated_at = ?
             WHERE project_id = ? AND revision = ?`
          )
          .bind(
            input.record.version,
            nextRevision,
            payload,
            input.record.updatedAt,
            projectId,
            input.expectedRevision
          )
          .run();
  if (result.meta?.changes !== 1) {
    throw new ProjectMeasurementRevisionConflictError(
      await currentRevision(db, projectId)
    );
  }
  return { revision: nextRevision, record: input.record };
}

export async function deleteProjectMeasurements(
  db: D1Database,
  projectId: string,
  expectedRevision: number
): Promise<void> {
  if (expectedRevision === 0) {
    if ((await currentRevision(db, projectId)) === 0) {
      return;
    }
    throw new ProjectMeasurementRevisionConflictError(
      await currentRevision(db, projectId)
    );
  }
  const result = await db
    .prepare(
      `DELETE FROM project_measurements
       WHERE project_id = ? AND revision = ?`
    )
    .bind(projectId, expectedRevision)
    .run();
  if (result.meta?.changes !== 1) {
    throw new ProjectMeasurementRevisionConflictError(
      await currentRevision(db, projectId)
    );
  }
}
