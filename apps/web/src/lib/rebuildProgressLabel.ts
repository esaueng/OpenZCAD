import type { RebuildProgress } from '@openzcad/kernel-adapter/exact';

const labels: Record<RebuildProgress['stage'], string> = {
  sources: 'Loading sources',
  history: 'Building history',
  feature: 'Building',
  checkpoint: 'Saving rebuild checkpoint',
  measurement: 'Measuring'
};

export function rebuildProgressLabel(
  progress?: RebuildProgress
): string | null {
  if (!progress) return null;
  const count =
    progress.total > 0 ? ` (${progress.index}/${progress.total})` : '';
  const timing =
    progress.status === 'completed'
      ? ` completed in ${((progress.durationMs ?? 0) / 1000).toFixed(1)}s`
      : '';
  return `${labels[progress.stage]}: ${progress.name}${count}${timing}`;
}
