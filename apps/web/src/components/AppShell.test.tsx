import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';

function renderShell(
  inspector: React.ReactNode | null,
  layout: 'classic' | 'column' = 'classic'
) {
  return render(
    <AppShell
      topBar={<header>top</header>}
      toolBar={<div>tools</div>}
      sidebar={<nav>sidebar</nav>}
      viewer={<div className="viewer-shell">viewer</div>}
      inspector={inspector}
      assistant={null}
      sidebarWidth={252}
      assistantWidth={360}
      sidebarResizer={<div className="sidebar-resizer">grip</div>}
      statusBar={<footer>status</footer>}
      layout={layout}
      readout={<output>readout</output>}
    />
  );
}

describe('AppShell inspector flag', () => {
  // The tool card centres on the room left of a docked panel, and the
  // stylesheet can only know a panel is docked from this class.
  it('marks the viewer area while an inspector is docked', () => {
    const { container } = renderShell(<section>panel</section>);
    const area = container.querySelector('.viewer-area');
    expect(area?.classList.contains('has-inspector')).toBe(true);
    expect(container.querySelector('.inspector-float')).not.toBeNull();
  });

  it('drops the flag with the panel', () => {
    const { container } = renderShell(null);
    const area = container.querySelector('.viewer-area');
    expect(area?.classList.contains('has-inspector')).toBe(false);
    expect(container.querySelector('.inspector-float')).toBeNull();
  });
});

describe('AppShell column layout', () => {
  it('floats the sidebar over the viewport and drops the status bar', () => {
    const { container } = renderShell(null, 'column');
    // The shell drops the status row with the bar, or a blank strip stays.
    expect(
      container.querySelector('.app-shell')?.classList.contains('column-layout')
    ).toBe(true);
    const workspace = container.querySelector('.workspace');
    expect(workspace?.classList.contains('column-layout')).toBe(true);
    // The grid no longer reserves a column for it, so the viewport is full width.
    expect(workspace?.classList.contains('no-sidebar')).toBe(true);
    expect(
      container.querySelector('.viewer-area .workspace-column-float nav')
    ).toHaveTextContent('sidebar');
    expect(container.querySelector('.sidebar-resizer')).toBeNull();
    expect(container.querySelector('footer')).toBeNull();
    expect(container.querySelector('.viewer-area output')).toHaveTextContent(
      'readout'
    );
  });

  it('keeps the classic layout docked', () => {
    const { container } = renderShell(null);
    expect(
      container.querySelector('.app-shell')?.classList.contains('column-layout')
    ).toBe(false);
    const workspace = container.querySelector('.workspace');
    expect(workspace?.classList.contains('column-layout')).toBe(false);
    expect(workspace?.classList.contains('no-sidebar')).toBe(false);
    expect(container.querySelector('.workspace-column-float')).toBeNull();
    expect(container.querySelector('.sidebar-resizer')).not.toBeNull();
    expect(container.querySelector('footer')).toHaveTextContent('status');
    expect(container.querySelector('output')).toBeNull();
  });
});
