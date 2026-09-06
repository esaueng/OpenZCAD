import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';

function renderShell(
  inspector: React.ReactNode | null,
  sidebar: React.ReactNode | null = <nav>sidebar</nav>
) {
  return render(
    <AppShell
      topBar={<header>top</header>}
      toolBar={null}
      sidebar={sidebar}
      viewer={<div className="viewer-shell">viewer</div>}
      inspector={inspector}
      assistant={null}
      sidebarWidth={252}
      assistantWidth={360}
      sidebarResizer={<div className="sidebar-resizer">grip</div>}
      readout={<output>readout</output>}
    />
  );
}

describe('AppShell', () => {
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

  it('floats the column and its splitter over the viewport, with no status row', () => {
    const { container } = renderShell(null);
    expect(
      container.querySelector('.app-shell')?.classList.contains('column-layout')
    ).toBe(true);
    // The grid never reserves a column for it, so the viewport is full width.
    expect(
      container.querySelector('.workspace')?.classList.contains('no-sidebar')
    ).toBe(true);
    expect(
      container.querySelector('.viewer-area .workspace-column-float nav')
    ).toHaveTextContent('sidebar');
    expect(
      container.querySelector('.viewer-area .sidebar-resizer')
    ).not.toBeNull();
    expect(container.querySelector('footer')).toBeNull();
    expect(container.querySelector('.viewer-area output')).toHaveTextContent(
      'readout'
    );
  });

  it('removes the column and its splitter together', () => {
    const { container } = renderShell(null, null);
    expect(container.querySelector('.workspace-column-float')).toBeNull();
    expect(container.querySelector('.sidebar-resizer')).toBeNull();
  });
});
