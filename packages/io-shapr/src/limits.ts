export interface ShaprImportLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryNameBytes: number;
  maxWorkspaceBytes: number;
  maxOtherEntryBytes: number;
  maxDeclaredOutputBytes: number;
  maxCompressionRatio: number;
  maxHistoryNodes: number;
  maxRecoveredOperations: number;
  maxSketches: number;
  maxSketchCurves: number;
  maxConstraints: number;
  maxJsonBytes: number;
  maxMessagePackBytes: number;
  maxValueDepth: number;
  maxValueNodes: number;
  maxStringBytes: number;
  maxArrayItems: number;
  maxControlPoints: number;
}

export const DEFAULT_SHAPR_IMPORT_LIMITS: Readonly<ShaprImportLimits> = {
  maxArchiveBytes: 32 * 1024 * 1024,
  maxEntries: 128,
  maxEntryNameBytes: 256,
  maxWorkspaceBytes: 64 * 1024 * 1024,
  maxOtherEntryBytes: 16 * 1024 * 1024,
  maxDeclaredOutputBytes: 96 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxHistoryNodes: 50_000,
  maxRecoveredOperations: 5_000,
  maxSketches: 2_000,
  maxSketchCurves: 250_000,
  maxConstraints: 100_000,
  maxJsonBytes: 2 * 1024 * 1024,
  maxMessagePackBytes: 1024 * 1024,
  maxValueDepth: 32,
  maxValueNodes: 100_000,
  maxStringBytes: 64 * 1024,
  maxArrayItems: 100_000,
  maxControlPoints: 2_000_000
};

export function resolveShaprImportLimits(
  overrides?: Partial<ShaprImportLimits>
): ShaprImportLimits {
  return { ...DEFAULT_SHAPR_IMPORT_LIMITS, ...overrides };
}
