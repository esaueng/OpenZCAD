import type { ShaprImportIR } from '@openzcad/io-shapr';
// Deep import on purpose: the package barrel pulls the zip, SQLite-WASM and
// MessagePack readers, and this module is in the entry chunk.
import { truncateCodeUnits } from '@openzcad/io-shapr/truncate';
import type { ShaprMigrationRecord } from '@openzcad/shared';

export type ShaprMigrationDraft = Omit<
  ShaprMigrationRecord,
  'importId' | 'exactGeometry'
>;

function safeFileName(name: string): string {
  const baseName = name.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const bounded = [...baseName]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === '/' ||
        character === '\\' ||
        code <= 0x1f ||
        code === 0x7f
        ? '_'
        : character;
    })
    .join('')
    .trim();
  const sanitized = truncateCodeUnits(bounded, 240);
  if (!sanitized) {
    throw new Error('Import source name is empty after privacy filtering.');
  }
  return sanitized;
}

/** Collapses the bounded parser IR into canonical, privacy-filtered evidence. */
export function shaprMigrationDraft(input: {
  ir: ShaprImportIR;
  shaprFileName: string;
  stepFileName: string;
  stepChecksumSha256: string;
  createdAt?: string;
}): ShaprMigrationDraft {
  const { ir } = input;
  if (!/^[0-9a-f]{64}$/.test(input.stepChecksumSha256)) {
    throw new Error('Companion STEP checksum is invalid.');
  }
  return {
    representation: 'openzcad-shapr-migration',
    version: 1,
    sourceName: safeFileName(input.shaprFileName),
    sourceChecksumSha256: ir.archive.checksumSha256,
    companionStepName: safeFileName(input.stepFileName),
    companionStepChecksumSha256: input.stepChecksumSha256,
    createdAt: input.createdAt ?? new Date().toISOString(),
    schema: { ...ir.schema },
    units: { ...ir.units },
    summary: {
      historyNodeCount: ir.historyNodeCount,
      sketchCount: ir.sketches.length,
      curveCount: ir.sketches.reduce(
        (count, sketch) => count + sketch.curves.length,
        0
      ),
      constraintCount: ir.sketches.reduce(
        (count, sketch) => count + sketch.constraints.length,
        0
      ),
      importedBodyCount: ir.opaqueGeometry.importedBodyCount,
      importedPrototypeCount: ir.opaqueGeometry.importedPrototypeCount,
      revisionBlockCount: ir.opaqueGeometry.revisionBlockCount,
      revisionDeltaCount: ir.opaqueGeometry.revisionDeltaCount
    },
    operations: ir.operations.map((operation) => ({
      sourceNodeId: operation.sourceNodeId,
      name: operation.name,
      kind: operation.kind,
      status: operation.status,
      numericCandidates: [...operation.numericCandidates],
      diagnostic: operation.diagnostic
    })),
    diagnostics: ir.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    semanticReplay: {
      status: 'not-applied',
      reason:
        'Units, coordinate frames, operands, operation schemas, and topology correspondence are not proven. Candidate history is evidence only.'
    },
    privateDataOmitted: true
  };
}
