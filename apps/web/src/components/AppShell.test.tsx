import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';

function shell(
  inspector: React.ReactNode | null,
  sidebar: React.ReactNode | null = <nav>sidebar</nav>
) {
  return (
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

function renderShell(
  inspector: React.ReactNode | null,
  sidebar: React.ReactNode | null = <nav>sidebar</nav>
) {
  return render(shell(inspector, sidebar));
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

  it('fades the inspector out, releasing the lane on the frame it closes', () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = renderShell(<section>panel</section>);
      rerender(shell(null));
      const area = container.querySelector('.viewer-area');
      expect(area?.classList.contains('has-inspector')).toBe(false);
      const leaving = container.querySelector('.inspector-float');
      expect(leaving?.classList.contains('closing')).toBe(true);
      expect(leaving?.textContent).toBe('panel');
      // A panel on its way out takes no input: Escape closing the inspector
      // must not leave the next shortcut key typing into its fields.
      expect((leaving as HTMLElement | null)?.inert).toBe(true);

      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(container.querySelector('.inspector-float')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  it('takes focus out of the inspector on the commit that closes it', () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = renderShell(
        <section>
          <input aria-label="Width" />
        </section>
      );
      const field = container.querySelector('input');
      field?.focus();
      expect(document.activeElement).toBe(field);
      rerender(shell(null));
      // Still mounted for its exit, but the next key must reach the
      // workspace, not the field of a form on its way out.
      expect(container.querySelector('.inspector-float input')).toBe(field);
      expect(document.activeElement).toBe(document.body);
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes the leaving column inert, and a present one live', () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = renderShell(null);
      const column = () =>
        container.querySelector<HTMLElement>('.workspace-column-float');
      expect(column()?.inert).toBe(false);
      rerender(shell(null, null));
      expect(column()?.classList.contains('closing')).toBe(true);
      expect(column()?.inert).toBe(true);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(column()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes the column and its splitter together', () => {
    const { container } = renderShell(null, null);
    expect(container.querySelector('.workspace-column-float')).toBeNull();
    expect(container.querySelector('.sidebar-resizer')).toBeNull();
  });
});
