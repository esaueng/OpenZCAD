import { useEffect, useRef, useState } from 'react';

interface FileDropTargetProps {
  /** Files dropped on the parent element from outside the page. */
  onDrop(files: File[]): void;
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
export function FileDropTarget({ onDrop }: FileDropTargetProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
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
      setActive(true);
    };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) {
        return;
      }
      // Without this the browser refuses the drop and navigates to the file.
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
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
      if (files.length > 0) {
        onDropRef.current(files);
      }
    };
    target.addEventListener('dragenter', enter);
    target.addEventListener('dragover', over);
    target.addEventListener('dragleave', leave);
    target.addEventListener('drop', drop);
    return () => {
      target.removeEventListener('dragenter', enter);
      target.removeEventListener('dragover', over);
      target.removeEventListener('dragleave', leave);
      target.removeEventListener('drop', drop);
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className={`file-drop-target${active ? ' active' : ''}`}
      aria-hidden="true"
    >
      <div>
        <strong>Drop to import</strong>
        <span>STEP, STL, or an .openzcad backup</span>
      </div>
    </div>
  );
}
