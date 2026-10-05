import type { ProjectDocument } from '@openzcad/shared';
import type {
  ResolveExtrudeOptions,
  ResolvedExtrude
} from './extrudeInference';

type PreviewOptions = Pick<
  ResolveExtrudeOptions,
  'input' | 'choice' | 'faceAttachment'
>;

export function resolvedExtrudePreviewKey(options: PreviewOptions): string {
  // The preview reserves the IDs that its eventual commit must keep.
  const { ids: _ids, ...input } = options.input;
  return JSON.stringify([input, options.choice, options.faceAttachment]);
}

export interface ResolvedExtrudePreview {
  baseProjectId: ProjectDocument['projectId'];
  baseVersion: number;
  key: string;
  resolved: ResolvedExtrude;
}

export function reuseResolvedExtrudePreview(
  preview: ResolvedExtrudePreview | null,
  options: PreviewOptions & { base: ProjectDocument }
): ResolvedExtrude | null {
  return preview?.baseProjectId === options.base.projectId &&
    preview.baseVersion === options.base.version &&
    preview.key === resolvedExtrudePreviewKey(options)
    ? preview.resolved
    : null;
}

/** An extrude preview frame still rebuilding (`LivePreview.running`). */
export interface RunningExtrudePreview {
  document: PreviewOptions & {
    baseProjectId: ProjectDocument['projectId'];
    baseVersion: number;
  };
  result: Promise<{ resolved: ResolvedExtrude; rejection: unknown }>;
}

/**
 * The extrude a preview frame still in flight resolves, when that frame is for
 * exactly this commit. Awaiting it costs the rest of one rebuild instead of
 * that rest plus a whole second one queued behind it in the worker. A frame
 * for another edit, a refused frame and a failed frame all answer null, which
 * leaves the commit to resolve its own exactly as it would without a preview.
 */
export async function reuseRunningExtrudePreview(
  running: RunningExtrudePreview | null,
  options: PreviewOptions & { base: ProjectDocument }
): Promise<ResolvedExtrude | null> {
  if (
    !running ||
    running.document.baseProjectId !== options.base.projectId ||
    running.document.baseVersion !== options.base.version ||
    resolvedExtrudePreviewKey(running.document) !==
      resolvedExtrudePreviewKey(options)
  ) {
    return null;
  }
  try {
    const result = await running.result;
    return result.rejection ? null : result.resolved;
  } catch {
    return null;
  }
}
