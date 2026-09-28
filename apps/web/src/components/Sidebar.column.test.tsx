import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  type BodyRepresentation,
  type FeatureNode,
  type FeatureId
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
    onResumeHistory: vi.fn(),
    units: 'mm',
    onSetParameter: vi.fn(),
    onViewActivityLog: vi.fn(),
    onDeleteParameter: vi.fn(),
    onRenameParameter: vi.fn().mockReturnValue(null),
    onExposeParameter: vi.fn(),
    onDescribeParameter: vi.fn(),
    exposedParameterNames: new Set(),
    onReorderFeature: vi.fn(),
    onRestoreCheckpoint: vi.fn(),
    onBranchCheckpoint: vi.fn(),
    panelState,
    onToggleSection: vi.fn(),
    ...overrides
  };
  return { ...render(<Sidebar {...props} />), props };
}

describe('Sidebar', () => {
  it('collapses History into one line that counts and names the newest feature', () => {
    const { container } = renderSidebar();
    const header = screen.getByTitle('Expand History');
    expect(container.querySelector('.history-scrub-dot')).toBeNull();
    expect(container.querySelector('.history-scrub-count')).toHaveTextContent(
      '3 features'
    );
    expect(container.querySelector('.history-scrub-name')).toHaveTextContent(
      '· at Feature 3'
    );
    // The position is not drawn, but the tooltip and the name carry it.
    expect(header).toHaveTextContent('step 3 of 3');
    expect(screen.getByTitle('Step 3 of 3: Feature 3')).toBeInTheDocument();
    // The count badge would say the same as the line; the line wins.
    expect(header.querySelector('.section-count')).toBeNull();
    // The column has its own header, so the docked caption goes.
    expect(container.querySelector('.sidebar-label')).toBeNull();
  });

  it('points the line at the selected feature', () => {
    const consumed = {
      bodyId: 'body-1',
      name: 'Body 1',
      consumed: true
    } as unknown as BodyRepresentation;
    renderSidebar({
      features: [
        feature(1, { bodyId: 'body-1' } as Partial<FeatureNode>),
        feature(2),
        feature(3)
      ],
      representations: { 'body-1': consumed },
      selectedFeatureNodeId: 'node-2'
    });
    const header = screen.getByTitle('Expand History');
    expect(header).toHaveTextContent('3 features · at Feature 2');
    expect(header).toHaveTextContent('step 2 of 3');
  });

  it('says where History is rolled back to', () => {
    const paused = {
      metadata: { [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: true }
    } as Partial<FeatureNode>;
    renderSidebar({
      features: [feature(1), feature(2, paused), feature(3, paused)]
    });
    const header = screen.getByTitle('Expand History');
    expect(header).toHaveTextContent('3 features · rolled back to Feature 1');
    expect(header).toHaveTextContent('step 1 of 3');
  });

  it('opens the list from the line', async () => {
    const user = userEvent.setup();
    const { props } = renderSidebar();
    await user.click(screen.getByTitle('Expand History'));
    expect(props.onToggleSection).toHaveBeenCalledWith('history');
  });

  it('closes on a double-click in its empty space', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderSidebar({ onClose });
    await user.dblClick(
      screen.getByRole('complementary', { name: 'Model browser' })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open when the double-click lands on a header or row', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const panelState = defaultPanelState();
    renderSidebar({ onClose, panelState });
    await user.dblClick(screen.getByTitle('Collapse History'));
    await user.dblClick(screen.getByText('Feature 2'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open when the double-click toggles a history disclosure', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderSidebar({
      onClose,
      panelState: defaultPanelState(),
      historyDetails: (
        <details open>
          <summary>Uses 1 feature</summary>
        </details>
      )
    });
    await user.dblClick(screen.getByText('Uses 1 feature'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
