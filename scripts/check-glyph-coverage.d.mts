export const SCANNED_ROOTS: readonly string[];

export function woff2CodePoints(buffer: Uint8Array): Set<number>;

export function unicodeRange(value: string): Set<number>;

export interface RenderedText {
  line: number;
  text: string;
}

export function sourceTexts(source: string, fileName?: string): RenderedText[];

export function stylesheetTexts(css: string): RenderedText[];

export interface UndrawnGlyph extends RenderedText {
  file: string;
  char: string;
  point: number;
}

export interface GlyphCoverageAudit {
  findings: UndrawnGlyph[];
  undrawnRanges: { file: string; point: number }[];
  stackFindings: string[];
  fileCount: number;
  textCount: number;
  coveredCount: number;
}

export function auditGlyphCoverage(repoRoot?: string): GlyphCoverageAudit;

export function describeAudit(audit: GlyphCoverageAudit): string;
