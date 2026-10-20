import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { FeatureId, FeatureNode } from '@openzcad/shared';
import { HistoryFindToggle, HistoryPanel, historyCount } from './HistoryPanel';
import { useHistoryFind } from './panelViews';

function feature(index: number): FeatureNode {
  return {
    id: `node-${index}`,
    kind: 'feature',
    name: `Feature ${index}`,
    featureId: `feature-${index}` as FeatureId,
    featureKind: 'extrude',
    data: { featureKind: 'extrude' }
  } as unknown as FeatureNode;
}

function Harness(
  overrides: Partial<Omit<ComponentProps<typeof HistoryPanel>, 'find'>>
) {
  const find = useHistoryFind();
  return (
    <>
      <HistoryFindToggle find={find} />
      <HistoryPanel
        features={[feature(1), feature(2)]}
        representations={{}}
        selectedFeatureNodeId={null}
        hiddenBodyIds={new Set()}
        hiddenSketchIds={new Set()}
        parameterValues={{}}
        units="mm"
        onSelectFeature={vi.fn()}
        onToggleBodyVisibility={vi.fn()}
        onToggleSketchVisibility={vi.fn()}
        onFeatureContextMenu={vi.fn()}
        onToggleFeatureSuppression={vi.fn()}
        onRollbackAfterFeature={vi.fn()}
        onResumeHistory={vi.fn()}
        onReorderFeature={vi.fn()}
        {...overrides}
        find={find}
      />
    </>
  );
}

describe('HistoryPanel', () => {
  it('lists the timeline with the details below it', () => {
    render(<Harness historyDetails={<p>Selected step details</p>} />);
    expect(screen.getByText('Feature 1')).toBeInTheDocument();
    expect(screen.getByText('Feature 2')).toBeInTheDocument();
    expect(screen.getByText('Selected step details')).toBeInTheDocument();
  });

  it('opens Find from the header toggle and hands focus back on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: 'Find a step' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(document.activeElement).toBe(
      screen.getByRole('searchbox', { name: 'Find a step' })
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('searchbox', { name: 'Find a step' })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it('counts features', () => {
    expect(historyCount([])).toBe(0);
    expect(historyCount([feature(1), feature(2), feature(3)])).toBe(3);
  });
});
