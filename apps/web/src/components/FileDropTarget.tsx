import { useEffect, useRef, useState } from 'react';
import { modalIsOpen } from '../lib/useModalFocus';

interface FileDropTargetProps {
  /** Files dropped on the parent element from outside the page. */
  onDrop(files: File[]): void;
  /**
   * Files dropped while a dialog is open, which are refused: the dialog is
   * still waiting on its own answer (an STL's units, an export).
   */
  onRefuse?(): void;
  /** The overlay's two lines; the workspace's import wording by default. */
  title?: string;
  hint?: string;
}

/** Whether a drag carries files from outside the page, as opposed to a row
 * being reordered inside it: the column's feature drag and the start screen's
 * project drag both travel as `text/plain`, never as `Files`. */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Makes its parent a drop target for files from the desktop, and lights the
 * whole stage while one is over it. The drop runs the same import the File
 * menu does; this is only the affordance.
 *
 * Listens on the parent rather than rendering as the target itself so the
 * viewer area needs no handlers of its own: the component is lazy, off the
 * entry chunk, and mounts long before anyone could have started a drag.
 *
 * `dragenter` and `dragleave` fire for every child the pointer crosses, so a
 * plain boolean flickers off and on across the whole viewport. A depth
 * counter — up on enter, down on leave, reset on drop — is what keeps the
 * overlay steady until the pointer actually leaves the target.
 */
export function FileDropTarget({
  onDrop,
  onRefuse,
  title = 'Drop to import',
  hint = 'STEP, DXF, a mesh file, a .shapr + STEP pair, or an .openzcad backup'
}: FileDropTargetProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const onRefuseRef = useRef(onRefuse);
  onRefuseRef.current = onRefuse;
  const [active, setActive] = useState(false);

  useEffect(() => {
    const target = hostRef.current?.parentElement;
    if (!target) {
      return;
    }
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) {
        return;
      }
      event.preventDefault();
      depth += 1;
      // Under a dialog the stage does not light: the drop would be refused.
      setActive(!modalIsOpen());
    };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) {
        return;
      }
      // Without this the browser refuses the drop and navigates to the file.
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = modalIsOpen() ? 'none' : 'copy';
      }
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) {
        return;
      }
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        setActive(false);
      }
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) {
        return;
      }
      event.preventDefault();
      depth = 0;
      setActive(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) {
        return;
      }
      // A file dropped under the Units dialog imported behind it, and the
      // next Escape then cancelled the first file instead.
      if (modalIsOpen()) {
        onRefuseRef.current?.();
        return;
      }
      onDropRef.current(files);
    };
    // A dialog's backdrop covers the stage, so a file dropped on it never
    // reaches the target above, and the browser would open the file in
    // place of the workspace. Swallow it there while a dialog is open.
    const guard = (event: DragEvent) => {
      if (
        !carriesFiles(event) ||
        !modalIsOpen() ||
        (event.target instanceof Node && target.contains(event.target))
      ) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'none';
      }
      if (event.type === 'drop') {
        onRefuseRef.current?.();
      }
    };
    target.addEventListener('dragenter', enter);
    target.addEventListener('dragover', over);
    target.addEventListener('dragleave', leave);
    target.addEventListener('drop', drop);
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      target.removeEventListener('dragenter', enter);
      target.removeEventListener('dragover', over);
      target.removeEventListener('dragleave', leave);
      target.removeEventListener('drop', drop);
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className={`file-drop-target${active ? ' active' : ''}`}
      aria-hidden="true"
    >
      <div>
        <strong>{title}</strong>
        <span>{hint}</span>
      </div>
    </div>
  );
}
