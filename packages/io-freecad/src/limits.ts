export interface FreecadImportLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryNameBytes: number;
  maxEntryBytes: number;
  maxDeclaredOutputBytes: number;
  maxCompressionRatio: number;
  maxObjects: number;
  maxBodies: number;
  maxStepBytes: number;
}

export const FREECAD_IMPORT_LIMITS: Readonly<FreecadImportLimits> = {
  maxArchiveBytes: 32 * 1024 * 1024,
  maxEntries: 4096,
  maxEntryNameBytes: 512,
  maxEntryBytes: 32 * 1024 * 1024,
  maxDeclaredOutputBytes: 128 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxObjects: 2048,
  maxBodies: 256,
  maxStepBytes: 128 * 1024 * 1024
};
