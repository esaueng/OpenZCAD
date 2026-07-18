import { createKernelAdapter } from '@openzcad/kernel-adapter';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { BodyId, ProjectDocument, ProjectId } from '@openzcad/shared';

export type GeometryWorkerRequest =
  | { type: 'sync'; document: ProjectDocument }
  | {
      type: 'export';
      requestId: string;
      document: ProjectDocument;
      bodyIds: BodyId[];
      format: 'step' | 'stl';
    };

/**
 * Result messages are tagged with the source document's identity so the main
 * thread can discard responses that no longer match the current document
 * (e.g. after a fast undo while a sync was in flight).
 */
export type GeometrySyncResult =
  | {
      type: 'sync';
      ok: true;
      projectId: ProjectId;
      version: number;
      derived: ProjectDocument['derived'];
    }
  | {
      type: 'sync';
      ok: false;
      projectId: ProjectId;
      version: number;
      error: string;
    };

export type GeometryExportResult =
  | {
      type: 'export';
      ok: true;
      requestId: string;
      format: 'step' | 'stl';
      text: string;
      warnings: string[];
    }
  | {
      type: 'export';
      ok: false;
      requestId: string;
      format: 'step' | 'stl';
      error: string;
    };

export type GeometryWorkerResult = GeometrySyncResult | GeometryExportResult;

const kernel = createKernelAdapter();
const exactKernel = createExactKernelAdapter().catch((error: unknown) => {
  console.warn(
    'Exact BrepKit kernel unavailable; using compatibility kernel.',
    error
  );
  return null;
});

self.onmessage = async (event: MessageEvent<GeometryWorkerRequest>) => {
  const request = event.data;
  const document = request.document;
  try {
    const exact = await exactKernel;
    if (request.type === 'export') {
      let text: string;
      let warnings: string[] = [];
      if (exact) {
        text =
          request.format === 'step'
            ? await exact.exportStep(document, request.bodyIds)
            : await exact.exportStl(document, request.bodyIds);
      } else if (request.format === 'step') {
        const fallback = kernel.exportStep(document, request.bodyIds);
        text = fallback.text;
        warnings = fallback.warnings;
      } else {
        text = kernel.exportStl(document, request.bodyIds);
      }
      const result: GeometryExportResult = {
        type: 'export',
        ok: true,
        requestId: request.requestId,
        format: request.format,
        text,
        warnings
      };
      self.postMessage(result);
      return;
    }
    const derived = exact
      ? await exact.syncDocument(document)
      : kernel.syncDocument(document);
    const result: GeometrySyncResult = {
      type: 'sync',
      ok: true,
      projectId: document.projectId,
      version: document.version,
      derived
    };
    self.postMessage(result);
  } catch (error) {
    if (request.type === 'export') {
      const result: GeometryExportResult = {
        type: 'export',
        ok: false,
        requestId: request.requestId,
        format: request.format,
        error:
          error instanceof Error ? error.message : 'Geometry export failed.'
      };
      self.postMessage(result);
      return;
    }
    const result: GeometrySyncResult = {
      type: 'sync',
      ok: false,
      projectId: document.projectId,
      version: document.version,
      error: error instanceof Error ? error.message : 'Geometry sync failed.'
    };
    self.postMessage(result);
  }
};

export {};
