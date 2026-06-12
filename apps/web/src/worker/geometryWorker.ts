import { createKernelAdapter } from '@openzcad/kernel-adapter';
import type { ProjectDocument, ProjectId } from '@openzcad/shared';

/**
 * Result messages are tagged with the source document's identity so the main
 * thread can discard responses that no longer match the current document
 * (e.g. after a fast undo while a sync was in flight).
 */
export type GeometrySyncResult =
  | {
      ok: true;
      projectId: ProjectId;
      version: number;
      derived: ProjectDocument['derived'];
    }
  | {
      ok: false;
      projectId: ProjectId;
      version: number;
      error: string;
    };

const kernel = createKernelAdapter();

self.onmessage = (event: MessageEvent<ProjectDocument>) => {
  const document = event.data;
  try {
    const derived = kernel.syncDocument(document);
    const result: GeometrySyncResult = {
      ok: true,
      projectId: document.projectId,
      version: document.version,
      derived
    };
    self.postMessage(result);
  } catch (error) {
    const result: GeometrySyncResult = {
      ok: false,
      projectId: document.projectId,
      version: document.version,
      error: error instanceof Error ? error.message : 'Geometry sync failed.'
    };
    self.postMessage(result);
  }
};

export {};
