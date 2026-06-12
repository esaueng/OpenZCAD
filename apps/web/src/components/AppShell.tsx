import type { ReactNode } from 'react';

interface AppShellProps {
  topBar: ReactNode;
  stepBar: ReactNode;
  viewer: ReactNode;
  contextPanel: ReactNode;
  /** Optional drawer between the workspace and the status bar. */
  bottomPanel?: ReactNode;
  statusBar: ReactNode;
}

/** Workspace layout frame: TopBar / [StepBar | Viewer | ContextPanel] / StatusBar. */
export function AppShell({
  topBar,
  stepBar,
  viewer,
  contextPanel,
  bottomPanel,
  statusBar
}: AppShellProps) {
  return (
    <div className="app-shell">
      {topBar}
      <main className="workspace">
        {stepBar}
        {viewer}
        {contextPanel}
      </main>
      {bottomPanel ?? <div />}
      {statusBar}
    </div>
  );
}
