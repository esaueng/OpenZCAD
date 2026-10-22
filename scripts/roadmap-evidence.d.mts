export const ROADMAP_PATH: string;
export const FRAGMENT_DIR: string;
export const FRAGMENT_NAME: RegExp;

export interface EvidenceFragment {
  name: string;
  row: string;
  state?: string;
  evidence: string;
}

export function parseFragment(name: string, source: string): EvidenceFragment;

export function splitRow(line: string): string[];

export function joinRow(cells: readonly string[]): string;

export function evidenceColumn(header: readonly string[]): number;

export function stateColumn(header: readonly string[]): number;

export function findRows(lines: readonly string[], row: string): number[];

export function foldEvidence(
  markdown: string,
  fragments: readonly EvidenceFragment[]
): string;

export function readFragments(repoRoot?: string): EvidenceFragment[];

export function checkRepo(repoRoot?: string): EvidenceFragment[];

export function foldRepo(repoRoot?: string): EvidenceFragment[];
