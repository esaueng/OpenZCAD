import { commandFactories } from '@openzcad/command-system';
import type { AssemblySet } from '@openzcad/shared';
import {
  assemblyRuntime,
  useAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import type { AssemblyExecute } from '../../lib/assembly/assembleWorkspace';

/**
 * AS03 exploded view: Assembled or Exploded (a view toggle, never saved),
 * how many parts are pulled out, and Reset, which puts every part back as
 * one undo step. The offsets themselves are edited by dragging parts on the
 * model while the view is exploded.
 */
export function AssemblyExplodedSection({
  set,
  execute,
  onStatus
}: {
  set: AssemblySet;
  execute: AssemblyExecute;
  onStatus(message: string): void;
}) {
  const exploded = useAssemblyRuntime((s) => s.exploded);
  const moved = Object.keys(set.explode?.offsets ?? {}).length;
  const show = (next: boolean) => {
    assemblyRuntime.setExploded(next);
    if (next)
      onStatus(
        moved > 0
          ? 'Exploded view · drag a part to move it out along X, Y or Z.'
          : 'Exploded view · drag a part to pull it out along X, Y or Z.'
      );
  };
  const reset = () => {
    if (
      execute(
        commandFactories.setAssemblyExplode(
          { reset: true, offsets: {} },
          'Reset exploded view'
        )
      )
    )
      onStatus('Every part is back in place.');
  };
  return (
    <div className="assembly-explode">
      <span className="assembly-segmented" role="group" aria-label="View">
        <button
          type="button"
          className={exploded ? undefined : 'is-active'}
          aria-pressed={!exploded}
          onClick={() => show(false)}
        >
          Assembled
        </button>
        <button
          type="button"
          className={exploded ? 'is-active' : undefined}
          aria-pressed={exploded}
          onClick={() => show(true)}
        >
          Exploded
        </button>
      </span>
      <p className="assembly-muted">
        {moved === 0
          ? exploded
            ? 'Drag a part to pull it out along X, Y or Z.'
            : 'No part is pulled out yet.'
          : `${moved} part${moved === 1 ? '' : 's'} pulled out${
              exploded ? '; drag to move.' : '.'
            }`}
      </p>
      {moved > 0 ? (
        <button
          type="button"
          className="assembly-link-button"
          onClick={reset}
          title="Put every part back; one undo step"
        >
          Reset
        </button>
      ) : null}
    </div>
  );
}
