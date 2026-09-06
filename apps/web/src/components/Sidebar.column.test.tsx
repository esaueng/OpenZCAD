import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  BodyRepresentation,
  FeatureNode,
  FeatureId
} from '@openzcad/shared';
import { defaultPanelState } from '../lib/panelState';
import { Sidebar } from './Sidebar';

function feature(
  index: number,
  overrides: Partial<FeatureNode> = {}
): FeatureNode {
  return {
    id: `node-${index}`,
    kind: 'feature',
    name: `Feature ${index}`,
    featureId: `feature-${index}` as FeatureId,
    featureKind: 'extrude',
    data: { featureKind: 'extrude' },
    ...overrides
  } as unknown as FeatureNode;
}

function renderSidebar(
  overrides: Partial<ComponentProps<typeof Sidebar>> = {}
) {
  const features = [feature(1), feature(2), feature(3)];
  const panelState = defaultPanelState();
  panelState.sidebarSections.history = false;
  const props: ComponentProps<typeof Sidebar> = {
    parameters: [],
    parameterValues: {},
    features,
    representations: {},
    selectedFeatureNodeId: null,
    selectedBodyIds: [],
    hiddenBodyIds: new Set(),
    hiddenSketchIds: new Set(),
    warnings: [],
    checkpoints: [],
    documentVersion: 1,
    restorableCheckpointIds: new Set(),
    onSelectFeature: vi.fn(),
    onSelectBody: vi.fn(),
    onToggleBodyVisibility: vi.fn(),
    onToggleSketchVisibility: vi.fn(),
    onFeatureContextMenu: vi.fn(),
    onToggleFeatureSuppression: vi.fn(),
    onRollbackAfterFeature: vi.fn(),
    onSetParameter: vi.fn(),
    onDeleteParameter: vi.fn(),
    onExposeParameter: vi.fn(),
    onDescribeParameter: vi.fn(),
    exposedParameterNames: new Set(),
    onDeleteFeature: vi.fn(),
    onReorderFeature: vi.fn(),
    onRestoreCheckpoint: vi.fn(),
    onBranchCheckpoint: vi.fn(),
    panelState,
    onToggleSection: vi.fn(),
    variant: 'column',
    ...overrides
  };
  return { ...render(<Sidebar {...props} />), props };
}

describe('Sidebar column variant', () => {
  it('collapses History into a scrub strip that names the newest feature', () => {
    const { container } = renderSidebar();
    const header = screen.getByTitle('Expand History');
    expect(container.querySelectorAll('.history-scrub-dot')).toHaveLength(3);
    expect(container.querySelector('.history-scrub-dot.active')).toBe(
      container.querySelectorAll('.history-scrub-dot')[2]
    );
    expect(header).toHaveTextContent('Feature 3');
    expect(header).toHaveTextContent('3/3');
    // The count badge would say the same as the position; the strip wins.
    expect(header.querySelector('.section-count')).toBeNull();
    // The column has its own header, so the docked caption goes.
    expect(container.querySelector('.sidebar-label')).toBeNull();
  });

  it('points the strip at the selected feature and marks consumed bodies', () => {
    const consumed = {
      bodyId: 'body-1',
      name: 'Body 1',
      consumed: true
    } as unknown as BodyRepresentation;
    const { container } = renderSidebar({
      features: [
        feature(1, { bodyId: 'body-1' } as Partial<FeatureNode>),
        feature(2),
        feature(3)
      ],
      representations: { 'body-1': consumed },
      selectedFeatureNodeId: 'node-2'
    });
    const dots = container.querySelectorAll('.history-scrub-dot');
    expect(dots[0]?.classList.contains('consumed')).toBe(true);
    expect(dots[1]?.classList.contains('active')).toBe(true);
    expect(screen.getByTitle('Expand History')).toHaveTextContent('Feature 2');
  });

  it('keeps the docked layout as it was', () => {
    const { container } = renderSidebar({ variant: 'dock' });
    expect(container.querySelector('.history-scrub')).toBeNull();
    expect(container.querySelector('.sidebar-label')).toHaveTextContent(
      'Model'
    );
    expect(screen.getByTitle('Expand History')).toHaveTextContent('3');
  });

  it('opens the list from the strip', async () => {
    const user = userEvent.setup();
    const { props } = renderSidebar();
    await user.click(screen.getByTitle('Expand History'));
    expect(props.onToggleSection).toHaveBeenCalledWith('history');
  });
});
