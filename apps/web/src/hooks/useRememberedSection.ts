import { useEffect, useRef } from 'react';
import type { SectionViewSettings } from '@openzcad/viewport';

/**
 * The full cut the section view returns to when it is switched back on: the
 * last section that was live; undefined before any.
 *
 * It follows whatever section is on screen, not only the planes picked in the
 * section panel: a project opens with its own saved section view, and turning
 * that cut off and on again must come back on the plane it was saved with,
 * not on the one last picked in another project. Kept small on purpose: it is
 * part of the workspace's eager entry chunk.
 */
export function useRememberedSection(
  sectionView: SectionViewSettings | undefined,
  projectId?: string | null
) {
  const section = useRef<SectionViewSettings | undefined>(sectionView);
  const project = useRef(projectId);
  useEffect(() => {
    if (project.current !== projectId) {
      project.current = projectId;
      section.current = sectionView;
    } else if (sectionView) {
      section.current = sectionView;
    }
  });
  return section;
}
