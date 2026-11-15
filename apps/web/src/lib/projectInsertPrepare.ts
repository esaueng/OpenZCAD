/**
 * Another project, reduced to what inserting its bodies needs: its name, one
 * millimetre STEP of every body it shows (named and coloured), and each
 * body's run of solids, colour and opacity. Run in a disposable worker
 * (`projectInsertWorker.ts`); see `projectInsert.ts` for how the result
 * lands in the open project.
 */
import {
  BODY_OPACITY_METADATA_KEY,
  chosenBodyColor,
  type UserId
} from '@openzcad/shared';
import { listNodesByKind } from '@openzcad/document-core';
import type {
  ExactKernelAdapter,
  StepBodySkipReason
} from '@openzcad/kernel-adapter/exact';

import {
  backupFileBytes,
  importProjectCopy,
  parseProjectBackup,
  readProjectBackupText
} from './projectBackup';
import { preloadDocumentFonts } from './textFonts';

/** One source body as it will be inserted. */
export interface ProjectInsertBody {
  name: string;
  /** How many declared solids it wrote, in file order. */
  solidCount: number;
  /** A colour someone chose for it; null when it is drawn in the default. */
  color: string | null;
  opacity: number | null;
}

/** The other project, reduced to what inserting it needs. */
export interface PreparedProjectInsert {
  projectName: string;
  /** Millimetre STEP of every written body, named and coloured. */
  stepText: string;
  bodies: ProjectInsertBody[];
  /** Shown bodies with nothing to write, by name. */
  skipped: { name: string; reason: StepBodySkipReason }[];
}

/**
 * Reads another project's backup and rebuilds it in a kernel of its own.
 * Nothing reaches this device's storage: the backup's own sources serve its
 * imported STEP and mesh features from memory.
 */
export async function prepareProjectInsert(
  file: Blob,
  ownerUserId: UserId
): Promise<PreparedProjectInsert> {
  const backup = importProjectCopy(
    await parseProjectBackup(await readProjectBackupText(file)),
    ownerUserId
  );
  const document = backup.document;
  const sources = new Map(
    (backup.sources ?? []).map((source) => [
      source.sha256,
      backupFileBytes(source)
    ])
  );
  await preloadDocumentFonts(document);
  const { createExactKernelAdapter } =
    await import('@openzcad/kernel-adapter/exact');
  let exact: ExactKernelAdapter | undefined;
  try {
    exact = await createExactKernelAdapter({
      resolveSourceBytes: (ref, { sourceName }) => {
        const bytes = sources.get(ref.checksumSha256);
        return bytes
          ? Promise.resolve(bytes)
          : Promise.reject(
              new Error(`The backup is missing the source of ${sourceName}.`)
            );
      }
    });
    const exported = await exact.exportStepBodies(document, {
      fileName: `${document.name}.step`
    });
    const bodyNodes = new Map(
      listNodesByKind(document, 'body').map((node) => [node.bodyId, node])
    );
    const featureKinds = new Map(
      listNodesByKind(document, 'feature').map((node) => [
        node.featureId,
        node.featureKind
      ])
    );
    return {
      projectName: document.name,
      stepText: exported.text,
      bodies: exported.bodies.map(({ bodyId, solidCount }) => {
        const node = bodyNodes.get(bodyId);
        const opacity = node?.metadata?.[BODY_OPACITY_METADATA_KEY];
        return {
          name: node?.name ?? 'Body',
          solidCount,
          color: chosenBodyColor(
            node?.metadata,
            node ? featureKinds.get(node.featureId) : undefined
          ),
          opacity: typeof opacity === 'number' ? opacity : null
        };
      }),
      skipped: exported.skipped.map(({ bodyId, reason }) => ({
        name: bodyNodes.get(bodyId)?.name ?? 'Body',
        reason
      }))
    };
  } finally {
    exact?.dispose();
  }
}
