import type { SectionPlaneId } from '@openzcad/viewport/types';

/** How the rails' Section buttons and the cut's chip name each plane. */
export const SECTION_PLANE_LABELS: Record<SectionPlaneId, string> = {
  XY: 'XY plane',
  XZ: 'XZ plane',
  YZ: 'YZ plane'
};
