import type { ReactNode } from 'react';
import { Upload } from 'lucide-react';
import { labelWithKey } from '../lib/keymap';
import { platformShortcutLabel } from '../lib/platformShortcut';

interface WorkspaceEmptyStateProps {
  /** The rail's own glyphs, so each button reads as the tool it starts. */
  boxIcon: ReactNode;
  sketchIcon: ReactNode;
  /** The live chords, as the user has them bound. */
  boxKey?: string | undefined;
  sketchKey?: string | undefined;
  onBox(): void;
  onSketch(): void;
  onImport(): void;
}

/**
 * The stage's invitation while a project holds nothing (see
 * lib/workspaceEmptyState for when): one line and the three ways to begin,
 * each running the command the rail, the key and the File menu already run.
 *
 * Only the buttons take the pointer. The section around them is a layout
 * box over the viewport and passes every press, drag and wheel through, so
 * the empty stage still orbits and zooms under it.
 *
 * Their names say "Start…" rather than repeat the rail's "Box (B)" and
 * "Sketch (S)": two controls on one screen answering to the same name is
 * what a screen reader's button list, and a test's locator, cannot tell
 * apart.
 */
export function WorkspaceEmptyState({
  boxIcon,
  sketchIcon,
  boxKey,
  sketchKey,
  onBox,
  onSketch,
  onImport
}: WorkspaceEmptyStateProps) {
  const key = (chord: string | undefined) =>
    chord ? platformShortcutLabel(chord) : undefined;
  return (
    <section className="stage-empty" aria-label="Start modeling">
      <p className="stage-empty-line">
        Nothing here yet
        <span className="stage-empty-wide">
          {' '}
          — start with a shape, a sketch or a file.
        </span>
      </p>
      <div className="stage-empty-actions">
        <button
          type="button"
          className="stage-empty-action"
          aria-label="Start with a box"
          title={labelWithKey('Box', boxKey)}
          onClick={onBox}
        >
          {boxIcon}
          <span>Box</span>
          {boxKey && (
            <kbd className="stage-empty-key" aria-hidden="true">
              {key(boxKey)}
            </kbd>
          )}
        </button>
        <button
          type="button"
          className="stage-empty-action"
          aria-label="Start a sketch"
          title={labelWithKey('Sketch', sketchKey)}
          onClick={onSketch}
        >
          {sketchIcon}
          <span>Sketch</span>
          {sketchKey && (
            <kbd className="stage-empty-key" aria-hidden="true">
              {key(sketchKey)}
            </kbd>
          )}
        </button>
        <button
          type="button"
          className="stage-empty-action"
          aria-label="Import CAD files to start from"
          title="Import STEP, a mesh file (STL, 3MF, OBJ, GLB, PLY) or a DXF drawing"
          onClick={onImport}
        >
          <Upload size={16} aria-hidden="true" />
          <span>
            Import<span className="stage-empty-wide"> CAD files</span>
          </span>
        </button>
      </div>
    </section>
  );
}
