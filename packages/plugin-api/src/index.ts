import type { SerializedCommand } from '@openzcad/shared';

export interface CommandPlugin {
  kind: string;
  register(): SerializedCommand[];
}

export interface FileAdapterPlugin {
  format: 'step' | 'stl';
  importDescription: string;
  exportDescription: string;
}

export interface FeaturePlugin {
  featureKind: string;
  label: string;
}

export interface JobPlugin {
  jobKind: string;
  description: string;
}

export interface PluginRegistry {
  commands: CommandPlugin[];
  fileAdapters: FileAdapterPlugin[];
  features: FeaturePlugin[];
  jobs: JobPlugin[];
}

export function createPluginRegistry(): PluginRegistry {
  return {
    commands: [],
    fileAdapters: [],
    features: [],
    jobs: []
  };
}

