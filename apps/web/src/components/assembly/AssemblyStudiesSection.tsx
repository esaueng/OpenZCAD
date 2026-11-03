import type { ProjectDocument } from '@openzcad/shared';
import type { AssemblyExecute } from '../../lib/assembly/assembleWorkspace';

export interface AssemblyStudiesSectionProps {
  document: ProjectDocument;
  execute: AssemblyExecute;
}

/**
 * The Assembly panel's Motion studies section (AS07). A placeholder slot:
 * the motion-study timeline replaces this component, keeping its props.
 */
export function AssemblyStudiesSection({
  document
}: AssemblyStudiesSectionProps) {
  const count = document.assembly?.studies.length ?? 0;
  return (
    <section className="assembly-section" aria-label="Motion studies">
      <h3 className="assembly-section-title">
        Motion studies
        <span className="assembly-count">{count}</span>
      </h3>
      {count === 0 ? (
        <p className="assembly-muted">No motion studies yet.</p>
      ) : null}
    </section>
  );
}
