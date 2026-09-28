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
