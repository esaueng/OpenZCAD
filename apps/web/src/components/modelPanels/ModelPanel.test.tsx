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
import { describe, expect, it, vi } from 'vitest';
import {
  type BodyId,
  type BodyRepresentation,
  type FeatureNode,
  type FeatureId,
  type ParameterNode,
  type ProjectCheckpoint
} from '@openzcad/shared';
import {
  createProjectDocument,
  createSavedRevision
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  loadLocalSaveState,
  saveLocalSaveStates
} from '../../lib/localProjectStore';
import type { PanelId } from '../../lib/panelLayout';
import { ModelPanel, type ModelPanelProps } from './ModelPanel';
import type { PanelControls } from './PanelFrame';
import { useHistoryFind, useObjectsView } from './panelViews';

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

function controls(overrides: Partial<PanelControls> = {}): PanelControls {
  return {
    placement: 'docked',
    status: 'docked',
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onClose: vi.fn(),
    onUse: vi.fn(),
    ...overrides
  };
}

type PanelSource = Omit<ModelPanelProps, 'id' | 'controls' | 'views'>;

function source(overrides: Partial<PanelSource> = {}): PanelSource {
  return {
    parameters: [],
    parameterValues: {},
    features: [feature(1), feature(2), feature(3)],
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
    ...overrides
  };
}

/** Panels side by side, as a docked column draws them. */
function Panels({
  ids,
  props,
  frame
}: {
  ids: readonly PanelId[];
  props: PanelSource;
  frame: PanelControls;
}) {
  const views = { objects: useObjectsView(), historyFind: useHistoryFind() };
  return (
    <>
      {ids.map((id) => (
        <ModelPanel
          key={id}
          id={id}
          controls={frame}
          views={views}
          {...props}
        />
      ))}
    </>
  );
}

function renderPanels(
  ids: readonly PanelId[],
  overrides: Partial<PanelSource> = {},
  frame: PanelControls = controls()
) {
  const props = source(overrides);
  const result = render(<Panels ids={ids} props={props} frame={frame} />);
  return {
    ...result,
    props,
    frame,
    rerender: (next: Partial<PanelSource>) =>
      result.rerender(
        <Panels ids={ids} props={{ ...props, ...next }} frame={frame} />
      )
  };
}

describe('ModelPanel', () => {
  it('hides local saves during navigation and reads late saved points when the view resumes', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const original = createProjectDocument(
      'Leaving project',
      toUserId('owner')
    );
    const saved = createSavedRevision(original, 'Before navigation');
    const sidebar = renderPanels(['revisions'], {
      projectId: original.projectId,
      checkpoints: original.checkpoints
    });
    try {
      await act(async () => {
        await saveLocalSaveStates([saved]);
      });
      await screen.findByRole('button', { name: 'Restore Before navigation' });
      sidebar.rerender({ projectId: undefined });
      expect(screen.queryByText('Before navigation')).not.toBeInTheDocument();
      await act(async () => {
        await saveLocalSaveStates([
          createSavedRevision(original, 'Completed after navigation')
        ]);
      });
      expect(
        screen.queryByText('Completed after navigation')
      ).not.toBeInTheDocument();
      sidebar.rerender({});
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
    const first = renderPanels(['revisions'], {
      projectId: original.projectId,
      checkpoints: original.checkpoints,
      documentVersion: point.documentVersion
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
      const reopened = renderPanels(['revisions'], first.props);
      try {
        await screen.findByRole('button', {
          name: 'Restore Device-only milestone'
        });
        const other = createProjectDocument('Other project', toUserId('owner'));
        reopened.rerender({
          projectId: other.projectId,
          checkpoints: other.checkpoints
        });
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
    const body = {
      bodyId: 'body-1',
      name: 'Original',
      consumed: true
    } as unknown as BodyRepresentation;
    renderPanels(['bodies'], { representations: { 'body-1': body } });
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
    renderPanels(['bodies']);
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
    const { props } = renderPanels(['bodies'], {
      features: [
        sketch,
        feature(2, { bodyId: body.bodyId }),
        feature(3, { bodyId: body.bodyId })
      ],
      representations: { [body.bodyId]: body },
      selectedBodyIds: [body.bodyId]
    });
    const list = within(screen.getByRole('list', { name: 'Objects' }));
    expect(screen.getByRole('heading', { name: 'Objects 2' })).toBeVisible();
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
    const sidebar = renderPanels(['bodies'], {
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
    sidebar.rerender({ hiddenSketchIds: new Set() });
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
    renderPanels(['bodies'], {
      features: sketches,
      selectedSketchProfileId: 'sketch-2'
    });
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

  it('keeps its search and Find field through a move that remounts it', async () => {
    const sketches = ['Base profile', 'Rib outline'].map((name, index) =>
      feature(index + 1, {
        name,
        featureKind: 'sketch',
        data: { featureKind: 'sketch', sketchId: `sketch-${index + 1}` }
      } as Partial<FeatureNode>)
    );
    const props = source({ features: sketches });
    // A move between the dock and the phone lane draws the panel under a
    // different parent; only its hoisted view state carries across.
    function Moving({ inLane }: { inLane: boolean }) {
      const views = {
        objects: useObjectsView(),
        historyFind: useHistoryFind()
      };
      const panels = (['bodies', 'history'] as const).map((id) => (
        <ModelPanel
          key={id}
          id={id}
          controls={controls()}
          views={views}
          {...props}
        />
      ));
      return inLane ? <section>{panels}</section> : <div>{panels}</div>;
    }
    const { rerender } = render(<Moving inLane={false} />);
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Find an object by name' }),
      'rib'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Find a step' }));
    rerender(<Moving inLane />);
    expect(
      screen.getByRole('searchbox', { name: 'Find an object by name' })
    ).toHaveValue('rib');
    expect(
      screen.getByRole('searchbox', { name: 'Find a step' })
    ).toBeInTheDocument();
  });

  it('keeps every body in the parameter toggle editor while an object search is active', async () => {
    // Objects and Parameters open side by side, each with its own state.
    const bodies = ['Plate', 'Spacer'].map(
      (name, index) =>
        ({
          bodyId: `body-${index + 1}`,
          name,
          consumed: false
        }) as unknown as BodyRepresentation
    );
    renderPanels(['bodies', 'parameters'], {
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
    const sidebar = renderPanels(['bodies'], {
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
    sidebar.rerender({ selectedSketchProfileId: null });
    expect(selected).toHaveAttribute('aria-pressed', 'false');
    expect(selected.closest('.object-row')).not.toHaveClass('selected');
  });

  it('keeps source bodies out of the sketch filter and restores their disclosure state', async () => {
    renderPanels(['bodies'], {
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
  it('heads each panel with its title and count, as a region named after it', () => {
    renderPanels(['history', 'parameters', 'revisions', 'diagnostics']);
    const history = screen.getByRole('region', { name: 'History' });
    expect(
      within(history).getByRole('heading', { name: 'History 3' })
    ).toBeVisible();
    // No count reads as no number at all, not "0".
    expect(screen.getByRole('heading', { name: 'Parameters' })).toBeVisible();
    // Revisions and Diagnostics open empty from the rail and say so.
    expect(
      within(screen.getByRole('region', { name: 'Revisions' })).getByText(
        /No save points yet/
      )
    ).toBeVisible();
    expect(screen.getByText('No warnings in this model.')).toBeVisible();
  });

  it('offers Pin and Close in the header, and no Pop out or fold', async () => {
    const user = userEvent.setup();
    const frame = controls();
    renderPanels(['history'], {}, frame);
    const region = within(screen.getByRole('region', { name: 'History' }));
    const pin = region.getByRole('button', { name: 'Pin History' });
    // Docked is pinned: the toggle reads pressed and unpins.
    expect(pin).toHaveAttribute('aria-pressed', 'true');
    await user.click(pin);
    expect(frame.onUnpin).toHaveBeenCalledTimes(1);
    expect(frame.onPin).not.toHaveBeenCalled();
    await user.click(region.getByRole('button', { name: 'Close History' }));
    expect(frame.onClose).toHaveBeenCalledTimes(1);
    expect(region.queryByRole('button', { name: /pop out|float/i })).toBeNull();
    // An open panel is fully open: nothing in the header folds it.
    expect(region.queryByRole('button', { expanded: false })).toBeNull();
    expect(region.queryByRole('button', { expanded: true })).toBeNull();
    // The rows are there without any disclosure.
    expect(region.getByText('Feature 2')).toBeVisible();
  });

  it('says it is unpinned in its footer and pins from there', async () => {
    const user = userEvent.setup();
    const frame = controls({ placement: 'unpinned', status: 'unpinned' });
    renderPanels(['parameters'], {}, frame);
    const region = within(screen.getByRole('region', { name: 'Parameters' }));
    expect(
      region.getByText('Unpinned — the next panel you open replaces it')
    ).toBeVisible();
    expect(
      region.getByRole('button', { name: 'Pin Parameters' })
    ).toHaveAttribute('aria-pressed', 'false');
    await user.click(region.getByRole('button', { name: 'Pin' }));
    await user.click(region.getByRole('button', { name: 'Pin Parameters' }));
    expect(frame.onPin).toHaveBeenCalledTimes(2);
    expect(frame.onUnpin).not.toHaveBeenCalled();
  });

  it('keeps the footer to the unpinned panel', () => {
    renderPanels(['bodies'], {}, controls({ placement: 'phone' }));
    expect(screen.queryByText(/Unpinned —/)).toBeNull();
  });

  it('counts a press or focus inside it as a use', async () => {
    const user = userEvent.setup();
    const frame = controls();
    renderPanels(['history'], {}, frame);
    await user.click(screen.getByText('Feature 2'));
    expect(frame.onUse).toHaveBeenCalled();
  });

  it('returns focus to the Find toggle when Escape closes the field', async () => {
    const user = userEvent.setup();
    renderPanels(['history']);
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
    const { container } = renderPanels(['revisions'], {
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
    const onSetParameter = vi.fn(async (name: string) =>
      name === 'w' ? 'Changing w would break Fillet 1.' : null
    );
    const { rerender } = renderPanels(['parameters'], {
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
    rerender({
      parameters: [parameter('w', '60'), parameter('h', '24')],
      parameterValues: { w: 60, h: 24 }
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
