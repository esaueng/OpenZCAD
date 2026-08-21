export const SCANNED_ROOTS: readonly string[];

export interface UnstyledAllowance {
  file: string;
  classes: string[];
  reason: string;
}

export const UNSTYLED_ALLOWANCES: readonly UnstyledAllowance[];

/** Class name to the co-required class lists it is defined alongside. */
export type ClassAnchors = Map<string, string[][]>;

export function ruleSelectors(css: string): string[];

export function compoundClassGroups(compound: string): string[][];

export function styleAnchors(css: string, into?: ClassAnchors): ClassAnchors;

export function isAnchored(
  classes: readonly string[],
  anchors: ClassAnchors
): boolean;

export function explainUnstyled(
  classes: readonly string[],
  anchors: ClassAnchors
): string;

export function literalSegments(expression: string): string[];

export interface ClassSite {
  line: number;
  classes: string[];
}

export function classSites(source: string): ClassSite[];

export interface UnstyledElement extends ClassSite {
  file: string;
  detail: string;
}

export interface ClassCoverageAudit {
  findings: UnstyledElement[];
  staleAllowances: UnstyledAllowance[];
  stylesheetCount: number;
  markupCount: number;
  definedClassCount: number;
}

export function auditClassCoverage(repoRoot?: string): ClassCoverageAudit;

export function describeAudit(audit: ClassCoverageAudit): string;
