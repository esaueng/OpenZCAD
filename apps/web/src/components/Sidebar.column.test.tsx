import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  type BodyId,
  type BodyRepresentation,
  type FeatureNode,
  type FeatureId,
  type ParameterNode,
  type ProjectCheckpoint
} from '@openzcad/shared';
import { defaultPanelState } from '../lib/panelState';
import {
  createProjectDocument,
  createSavedRevision
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  loadLocalSaveState,
  saveLocalSaveStates
} from '../lib/localProjectStore';
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
    selectedSketchProfileId: null,
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
  it('hides local saves during navigation and reads late saved points when the view resumes', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const original = createProjectDocument(
      'Leaving project',
      toUserId('owner')
    );
    const saved = createSavedRevision(original, 'Before navigation');
    const panelState = defaultPanelState();
    panelState.sidebarSections.revisions = true;
    const sidebar = renderSidebar({
      projectId: original.projectId,
      checkpoints: original.checkpoints,
      panelState
    });
    try {
      await act(async () => {
        await saveLocalSaveStates([saved]);
      });
      await screen.findByRole('button', { name: 'Restore Before navigation' });
      sidebar.rerender(<Sidebar {...sidebar.props} projectId={undefined} />);
      expect(screen.queryByText('Before navigation')).not.toBeInTheDocument();
      await act(async () => {
        await saveLocalSaveStates([
          createSavedRevision(original, 'Completed after navigation')
        ]);
      });
      expect(
        screen.queryByText('Completed after navigation')
      ).not.toBeInTheDocument();
      sidebar.rerender(<Sidebar {...sidebar.props} />);
      await screen.findByRole('button', { name: 'Restore Before navigation' });
      await screen.findByRole('button', {
        name: 'Restore Completed after navigation'
      });
      expect(sidebar.props.checkpoints).toEqual(original.checkpoints);
    } finally {
      sidebar.unmount();
    }
  });

  it('shows device-only saved states after commit and reopen without adding them to the document', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const original = createProjectDocument(
      'Private local state',
      toUserId('owner')
    );
    const saved = createSavedRevision(original, 'Device-only milestone');
    const point = saved.checkpoints.at(-1)!;
    const panelState = defaultPanelState();
    panelState.sidebarSections.revisions = true;
    const first = renderSidebar({
      projectId: original.projectId,
      checkpoints: original.checkpoints,
      documentVersion: point.documentVersion,
      panelState
    });
    try {
      expect(
        screen.queryByText('Device-only milestone')
      ).not.toBeInTheDocument();
      await act(async () => {
        await saveLocalSaveStates([saved]);
      });
      const restore = await screen.findByRole('button', {
        name: 'Restore Device-only milestone'
      });
      expect(
        screen.getByTitle(/Device-only milestone.*Stored on this device/)
      ).toBeInTheDocument();
      await userEvent.click(restore);
      expect(first.props.onRestoreCheckpoint).toHaveBeenCalledExactlyOnceWith(
        point
      );
      expect(first.props.checkpoints).toEqual(original.checkpoints);
      expect(
        (await loadLocalSaveState(original.projectId, point.checkpointId))
          ?.nodes
      ).toEqual(original.nodes);
      first.unmount();
      const reopened = renderSidebar(first.props);
      try {
        await screen.findByRole('button', {
          name: 'Restore Device-only milestone'
        });
        const other = createProjectDocument('Other project', toUserId('owner'));
        reopened.rerender(
          <Sidebar
            {...reopened.props}
            projectId={other.projectId}
            checkpoints={other.checkpoints}
          />
        );
        expect(
          screen.queryByText('Device-only milestone')
        ).not.toBeInTheDocument();
        await act(async () => {
          await saveLocalSaveStates([
            createSavedRevision(other, 'Other device state')
          ]);
        });
        await screen.findByRole('button', {
          name: 'Restore Other device state'
        });
        expect(
          screen.queryByText('Device-only milestone')
        ).not.toBeInTheDocument();
      } finally {
        reopened.unmount();
      }
    } finally {
      first.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('keeps the consumed-source disclosure inside a list item', async () => {
    const panelState = defaultPanelState();
    panelState.sidebarSections.bodies = true;
    const body = {
      bodyId: 'body-1',
      name: 'Original',
      consumed: true
    } as unknown as BodyRepresentation;
    renderSidebar({ panelState, representations: { 'body-1': body } });
    const list = screen.getByRole('list', { name: 'Objects' });
    expect(
      [...list.children].every(
        (child) => child.getAttribute('role') === 'listitem'
      )
    ).toBe(true);
    const disclosure = screen.getByRole('button', { name: '1 source body' });
    await userEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByRole('button', { name: 'Original' })
    ).toBeInTheDocument();
  });
  it('gives the empty Objects message list-item semantics', () => {
    const panelState = defaultPanelState();
    panelState.sidebarSections.bodies = true;
    renderSidebar({ panelState });
    expect(
      screen.getByText(
        'No objects yet. Create a body or sketch to get started.'
      )
    ).toHaveAttribute('role', 'listitem');
  });

  it('lists bodies and sketches once, counts both types, and filters without changing selection', async () => {
    const body = {
      bodyId: 'body-1',
      name: 'Plate',
      consumed: false
    } as unknown as BodyRepresentation;
    const sketch = feature(1, {
      name: 'Outline',
      featureKind: 'sketch',
      data: { featureKind: 'sketch', sketchId: 'sketch-1' }
    } as Partial<FeatureNode>);
    const { props } = renderSidebar({
      features: [
        sketch,
        feature(2, { bodyId: body.bodyId }),
        feature(3, { bodyId: body.bodyId })
      ],
      representations: { [body.bodyId]: body },
      selectedBodyIds: [body.bodyId]
    });
    const list = within(screen.getByRole('list', { name: 'Objects' }));
    expect(screen.getByTitle('Collapse Objects')).toHaveTextContent('Objects2');
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    expect(list.getByRole('button', { name: 'Plate' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const filter = screen.getByRole('combobox', {
      name: 'Filter objects by type'
    });
    await userEvent.selectOptions(filter, 'sketches');
    expect(
      list.queryByRole('button', { name: 'Plate' })
    ).not.toBeInTheDocument();
    await userEvent.click(list.getByRole('button', { name: 'Outline' }));
    expect(props.onSelectFeature).toHaveBeenCalledExactlyOnceWith(sketch.id);
    await userEvent.selectOptions(filter, 'bodies');
    expect(
      list.queryByRole('button', { name: 'Outline' })
    ).not.toBeInTheDocument();
    expect(list.getByRole('button', { name: 'Plate' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await userEvent.click(list.getByRole('button', { name: 'Plate' }));
    expect(props.onSelectBody).toHaveBeenCalledExactlyOnceWith(
      body.bodyId,
      false
    );
    await userEvent.selectOptions(filter, 'all');
    expect(list.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows sketches without body geometry and uses their own visibility and selected state', async () => {
    const sketch = feature(1, {
      name: 'Profile',
      featureKind: 'sketch',
      data: { featureKind: 'sketch', sketchId: 'sketch-1' }
    } as Partial<FeatureNode>);
    const sidebar = renderSidebar({
      features: [sketch],
      selectedFeatureNodeId: sketch.id,
      hiddenSketchIds: new Set(['sketch-1'])
    });
    const list = within(screen.getByRole('list', { name: 'Objects' }));
    expect(list.getByRole('button', { name: 'Profile' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(list.queryByText(/No objects yet/)).not.toBeInTheDocument();
    await userEvent.click(
      list.getByRole('button', { name: 'Show sketch Profile' })
    );
    expect(
      sidebar.props.onToggleSketchVisibility
    ).toHaveBeenCalledExactlyOnceWith('sketch-1');
    expect(sidebar.props.onToggleBodyVisibility).not.toHaveBeenCalled();
    sidebar.rerender(
      <Sidebar {...sidebar.props} hiddenSketchIds={new Set()} />
    );
    await userEvent.click(
      list.getByRole('button', { name: 'Hide sketch Profile' })
    );
    expect(sidebar.props.onToggleSketchVisibility).toHaveBeenCalledTimes(2);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Filter objects by type' }),
      'bodies'
    );
    expect(
      list.getByText('No bodies yet. Create a primitive or extrude a sketch.')
    ).toHaveAttribute('role', 'listitem');
  });

  it('finds objects by name without changing selection or the full list (ZC-126)', async () => {
    const sketches = ['Base profile', 'Rib outline', 'Base pocket'].map(
      (name, index) =>
        feature(index + 1, {
          name,
          featureKind: 'sketch',
          data: { featureKind: 'sketch', sketchId: `sketch-${index + 1}` }
        } as Partial<FeatureNode>)
    );
    renderSidebar({ features: sketches, selectedSketchProfileId: 'sketch-2' });
    const list = within(screen.getByRole('list', { name: 'Objects' }));
    const field = screen.getByRole('searchbox', {
      name: 'Find an object by name'
    });
    const names = () =>
      list
        .getAllByRole('button', { pressed: undefined })
        .filter((button) => button.classList.contains('body-row-main'))
        .map((button) => button.textContent);
    expect(names()).toEqual(['Base profile', 'Rib outline', 'Base pocket']);
    await userEvent.type(field, 'base');
    expect(names()).toEqual(['Base profile', 'Base pocket']);
    await userEvent.clear(field);
    await userEvent.type(field, 'nothing');
    expect(list.getByText('No objects match “nothing”.')).toBeInTheDocument();
    // Escape clears the search and restores exactly the same rows, with the
    // selection untouched.
    await userEvent.type(field, '{Escape}');
    expect(field).toHaveValue('');
    expect(names()).toEqual(['Base profile', 'Rib outline', 'Base pocket']);
    expect(list.getByRole('button', { name: 'Rib outline' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('keeps every body in the parameter toggle editor while an object search is active', async () => {
    const bodies = ['Plate', 'Spacer'].map(
      (name, index) =>
        ({
          bodyId: `body-${index + 1}`,
          name,
          consumed: false
        }) as unknown as BodyRepresentation
    );
    renderSidebar({
      features: [
        feature(1, { bodyId: 'body-1' as BodyId }),
        feature(2, { bodyId: 'body-2' as BodyId })
      ],
      representations: { 'body-1': bodies[0]!, 'body-2': bodies[1]! },
      onConfigureToggle: vi.fn()
    });
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Find an object by name' }),
      'plate'
    );
    fireEvent.change(screen.getByLabelText('New parameter type'), {
      target: { value: 'toggle' }
    });
    const editor = within(
      screen.getByRole('group', { name: 'Show these bodies when on' })
    );
    expect(editor.getByLabelText('Plate')).toBeInTheDocument();
    expect(editor.getByLabelText('Spacer')).toBeInTheDocument();
  });

  it('tracks viewport sketch selection independently of the selected history feature', () => {
    const sketches = [1, 2].map((index) =>
      feature(index, {
        name: `Profile ${index}`,
        featureKind: 'sketch',
        data: { featureKind: 'sketch', sketchId: `sketch-${index}` }
      } as Partial<FeatureNode>)
    );
    const sidebar = renderSidebar({
      features: sketches,
      selectedSketchProfileId: 'sketch-2'
    });
    const list = within(screen.getByRole('list', { name: 'Objects' }));
    expect(list.getByRole('button', { name: 'Profile 1' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    const selected = list.getByRole('button', { name: 'Profile 2' });
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(selected.closest('.object-row')).toHaveClass('selected');
    sidebar.rerender(
      <Sidebar {...sidebar.props} selectedSketchProfileId={null} />
    );
    expect(selected).toHaveAttribute('aria-pressed', 'false');
    expect(selected.closest('.object-row')).not.toHaveClass('selected');
  });

  it('keeps source bodies out of the sketch filter and restores their disclosure state', async () => {
    renderSidebar({
      representations: {
        source: {
          bodyId: 'source',
          name: 'Source',
          consumed: true
        } as unknown as BodyRepresentation
      }
    });
    await userEvent.click(
      screen.getByRole('button', { name: '1 source body' })
    );
    const filter = screen.getByRole('combobox', {
      name: 'Filter objects by type'
    });
    await userEvent.selectOptions(filter, 'sketches');
    expect(
      screen.queryByRole('button', { name: 'Source' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '1 source body' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('No sketches yet. Start a sketch on a plane or face.')
    ).toBeInTheDocument();
    await userEvent.selectOptions(filter, 'all');
    expect(screen.getByRole('button', { name: 'Source' })).toBeInTheDocument();
  });
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
    // A plain leading space collapses at the start of the flex item, which
    // ran the count into the dot ("3 features·").
    expect(container.querySelector('.history-scrub-name')?.textContent).toMatch(
      /^\u00a0· /
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

  it('stays open when the double-click selects text in the history details', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderSidebar({
      onClose,
      panelState: defaultPanelState(),
      historyDetails: (
        <section className="feature-history-panel" aria-label="History details">
          <p>Edit not saved · Fillet 1</p>
        </section>
      )
    });
    // Double-clicking a word to copy an error closed the whole drawer.
    await user.dblClick(screen.getByText('Edit not saved · Fillet 1'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns focus to the Find toggle when Escape closes the field', async () => {
    const user = userEvent.setup();
    renderSidebar({ panelState: defaultPanelState() });
    const toggle = screen.getByRole('button', { name: 'Find a step' });
    await user.click(toggle);
    const field = screen.getByRole('searchbox', { name: 'Find a step' });
    expect(document.activeElement).toBe(field);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('searchbox', { name: 'Find a step' })).toBeNull();
    // The field unmounted with focus in it, which dropped focus on the body.
    expect(document.activeElement).toBe(toggle);
  });

  it("shows the time of today's save points and the date of older ones", () => {
    const panelState = defaultPanelState();
    panelState.sidebarSections.revisions = true;
    const today = new Date();
    today.setHours(9, 5, 0, 0);
    const older = new Date(2025, 0, 15, 9, 5);
    const checkpoint = (
      id: string,
      createdAt: Date,
      documentVersion: number
    ): ProjectCheckpoint =>
      ({
        checkpointId: id,
        revisionId: `rev-${id}`,
        documentVersion,
        createdAt: createdAt.toISOString(),
        reason: 'Manual save'
      }) as ProjectCheckpoint;
    const { container } = renderSidebar({
      panelState,
      checkpoints: [checkpoint('a', older, 1), checkpoint('b', today, 2)]
    });
    const times = [...container.querySelectorAll('.revision-time')].map(
      (time) => time.textContent
    );
    // Newest first. Two same-day "Manual save" rows used to read the same.
    expect(times).toEqual([
      today.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit'
      }),
      older.toLocaleDateString()
    ]);
  });

  it('clears a parameter refusal once another parameter change goes through', async () => {
    const user = userEvent.setup();
    const parameter = (name: string, expression: string) =>
      ({
        id: `node_${name}`,
        kind: 'parameter',
        parameterId: `parameter_${name}`,
        name,
        expression,
        value: Number(expression)
      }) as unknown as ParameterNode;
    const panelState = defaultPanelState();
    panelState.sidebarSections.parameters = true;
    const onSetParameter = vi.fn(async (name: string) =>
      name === 'w' ? 'Changing w would break Fillet 1.' : null
    );
    const { rerender, props } = renderSidebar({
      panelState,
      parameters: [parameter('w', '60'), parameter('h', '20')],
      parameterValues: { w: 60, h: 20 },
      onSetParameter
    });
    const width = screen.getByLabelText('Expression for w');
    await user.clear(width);
    await user.type(width, '70{Enter}');
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Changing w would break Fillet 1. No change applied.'
      )
    );
    const height = screen.getByLabelText('Expression for h');
    await user.clear(height);
    await user.type(height, '24{Enter}');
    rerender(
      <Sidebar
        {...props}
        parameters={[parameter('w', '60'), parameter('h', '24')]}
        parameterValues={{ w: 60, h: 24 }}
      />
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
