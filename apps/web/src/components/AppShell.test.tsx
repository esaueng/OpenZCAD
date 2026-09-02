import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';

function renderShell(inspector: React.ReactNode | null) {
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
      statusBar={<footer>status</footer>}
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
