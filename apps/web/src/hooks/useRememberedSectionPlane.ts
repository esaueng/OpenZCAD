import { useEffect, useRef } from 'react';
import type { SectionPlaneId, SectionViewSettings } from '@openzcad/viewport';

/**
 * The plane the section view returns to when it is switched back on: the
 * plane of the last section that was live, XY before any.
 *
 * It follows whatever section is on screen, not only the planes picked in the
 * section panel: a project opens with its own saved section view, and turning
 * that cut off and on again must come back on the plane it was saved with,
 * not on the one last picked in another project. Kept small on purpose: it is
 * part of the workspace's eager entry chunk.
 */
export function useRememberedSectionPlane(
  sectionView: SectionViewSettings | undefined
) {
  const plane = useRef<SectionPlaneId>(sectionView?.plane ?? 'XY');
  useEffect(() => {
    if (sectionView) plane.current = sectionView.plane;
  });
  return plane;
}
