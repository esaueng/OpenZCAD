export interface SkippedDataProject {
  projectId: string;
  name: string;
  scope: 'local' | 'cloud';
  reason: string;
}

export interface DataExportSummary {
  includedProjects: number;
  skippedProjects: SkippedDataProject[];
  omittedSections: { name: string; reason: string }[];
}
