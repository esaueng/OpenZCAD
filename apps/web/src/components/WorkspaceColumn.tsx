import type { ReactNode } from 'react';

interface WorkspaceColumnProps {
  /** Mode header: the sketch being edited with its Finish; null for none. */
  header: ReactNode | null;
  /** The mode's tools — the feature palette, or the sketch rail. */
  tools: ReactNode | null;
  /**
   * The model browser, when the column carries it. The quiet stage keeps the
   * browser in the drawer on the right, so Build passes none.
   */
  children?: ReactNode;
}

/**
 * The single floating column of the column workspace layout: what the user
 * can do (tools) above what they have made (the browser), in reading order.
 * It composes existing components rather than owning any state — the pieces
 * keep their behaviour from the classic layout and only their frame changes.
 */
export function WorkspaceColumn({
  header,
  tools,
  children
}: WorkspaceColumnProps) {
  return (
    <div className="workspace-column">
      {header && <div className="workspace-column-header">{header}</div>}
      {tools && <div className="workspace-column-tools">{tools}</div>}
      {children && <div className="workspace-column-browser">{children}</div>}
    </div>
  );
}
