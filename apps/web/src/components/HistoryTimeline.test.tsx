import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  FEATURE_SUPPRESSED_METADATA_KEY
} from '@openzcad/shared';
import type { FeatureId, FeatureNode } from '@openzcad/shared';
import { findRollbackMarkerIndex, HistoryTimeline } from './HistoryTimeline';

function feature(
  index: number,
  data: Record<string, unknown> = { featureKind: 'extrude', distance: index },
  metadata?: Record<string, unknown>
): FeatureNode {
  return {
    id: `node-${index}`,
    kind: 'feature',
    name: `Feature ${index}`,
    featureId: `feature-${index}` as FeatureId,
    featureKind: data.featureKind,
    data,
    ...(metadata ? { metadata } : {})
  } as unknown as FeatureNode;
}

const rolledBack = { [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: true };

function timelineProps(
  overrides: Partial<ComponentProps<typeof HistoryTimeline>> = {}
): ComponentProps<typeof HistoryTimeline> {
  return {
    features: [feature(1), feature(2), feature(3), feature(4)],
    representations: {},
    selectedFeatureNodeId: null,
    hiddenBodyIds: new Set(),
    hiddenSketchIds: new Set(),
    parameterValues: {},
    units: 'mm',
    findOpen: false,
    onCloseFind: vi.fn(),
    onSelectFeature: vi.fn(),
    onToggleBodyVisibility: vi.fn(),
    onToggleSketchVisibility: vi.fn(),
    onFeatureContextMenu: vi.fn(),
    onToggleFeatureSuppression: vi.fn(),
    onRollbackAfterFeature: vi.fn(),
    onResumeHistory: vi.fn(),
    onReorderFeature: vi.fn(),
    ...overrides
  };
}

function renderTimeline(
  overrides: Partial<ComponentProps<typeof HistoryTimeline>> = {}
) {
  const props = timelineProps(overrides);
  return { ...render(<HistoryTimeline {...props} />), props };
}

function row(name: string): HTMLElement {
  return screen.getByText(name).closest('.feature-row') as HTMLElement;
}

it('shows preparation instead of repair while accepted geometry awaits analysis', () => {
  const pending = feature(1);
  pending.bodyId = 'body-pending' as FeatureNode['bodyId'];
  const { rerender, props } = renderTimeline({
    features: [pending],
    geometryPending: true
  });
  expect(screen.getByText('preparing')).toBeInTheDocument();
  expect(screen.queryByText('needs repair')).not.toBeInTheDocument();
  rerender(<HistoryTimeline {...props} geometryPending={false} />);
  expect(screen.getByText('needs repair')).toBeInTheDocument();
});

it('keeps a brief rebuild quiet without calling the step broken', () => {
  const pending = feature(1);
  pending.bodyId = 'body-pending' as FeatureNode['bodyId'];
  renderTimeline({
    features: [pending],
    geometryPending: true,
    geometryPendingShown: false
  });
  expect(screen.queryByText('preparing')).not.toBeInTheDocument();
  expect(screen.queryByText('needs repair')).not.toBeInTheDocument();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HistoryTimeline', () => {
  it('marks only the last feature before a rollback-suppressed suffix', () => {
    expect(
      findRollbackMarkerIndex([
        feature(1),
        feature(2, undefined, rolledBack),
        feature(3, undefined, rolledBack)
      ])
    ).toBe(0);
    expect(
      findRollbackMarkerIndex([
        feature(1, undefined, rolledBack),
        feature(2, undefined, rolledBack)
      ])
    ).toBe(-1);
  });

  it('finds a rollback marker with linear feature reads when no marker exists', () => {
    const items = Array.from({ length: 512 }, (_, index) => feature(index));
    let featureReads = 0;
    const measuredItems = new Proxy(items, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
          featureReads += 1;
        }
        return Reflect.get(target, property, receiver) as unknown;
      }
    });

    expect(findRollbackMarkerIndex(measuredItems)).toBe(-1);
    expect(featureReads).toBeLessThanOrEqual(items.length);
  });

  it('shows one value per row in document units', () => {
    renderTimeline({ units: 'inch' });
    expect(row('Feature 3')).toHaveTextContent('3 in');
  });

  it('says how much is paused and resumes from the status line', async () => {
    const user = userEvent.setup();
    const { props } = renderTimeline({
      features: [
        feature(1),
        feature(2, undefined, { [FEATURE_SUPPRESSED_METADATA_KEY]: true }),
        feature(3, undefined, rolledBack),
        feature(4, undefined, rolledBack)
      ]
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Rolled back · 2 later features paused'
    );
    // Rollback pauses; only a manual suppression reads as suppressed.
    expect(row('Feature 2')).toHaveTextContent('suppressed');
    expect(row('Feature 3')).toHaveTextContent('paused');
    expect(row('Feature 3')).not.toHaveTextContent('suppressed');
    expect(
      screen.getByRole('slider', { name: 'End of history' })
    ).toHaveAttribute('aria-valuetext', 'After Feature 2');
    await user.click(
      screen.getByRole('button', { name: 'Resume full history' })
    );
    expect(props.onResumeHistory).toHaveBeenCalledTimes(1);
  });

  it('has no status line while the history is complete', () => {
    renderTimeline();
    expect(screen.queryByRole('status')).toBeNull();
    expect(
      screen.getByRole('slider', { name: 'End of history' })
    ).toHaveAttribute('aria-valuetext', 'Full history');
  });

  it('commits one rollback after a burst of keyboard steps on the handle', () => {
    vi.useFakeTimers();
    const { props } = renderTimeline();
    const handle = screen.getByRole('slider', { name: 'End of history' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    // Previewed, not yet committed: later rows already read as paused.
    expect(handle).toHaveAttribute('aria-valuenow', '2');
    expect(row('Feature 3')).toHaveTextContent('paused');
    expect(props.onRollbackAfterFeature).not.toHaveBeenCalled();
    act(() => {
      vi.runAllTimers();
    });
    expect(props.onRollbackAfterFeature).toHaveBeenCalledTimes(1);
    expect(props.onRollbackAfterFeature).toHaveBeenCalledWith(
      'feature-2',
      'Feature 2'
    );
  });

  it('keeps a paused feature paused after it is reordered above the handle', () => {
    // moveFeature changes only the order, so a rollback-paused feature can sit
    // before the last feature still in the build; its metadata still pauses it.
    renderTimeline({
      features: [
        feature(1),
        feature(2, undefined, rolledBack),
        feature(3),
        feature(4, undefined, rolledBack)
      ]
    });
    expect(row('Feature 2')).toHaveTextContent('paused');
    expect(row('Feature 2')).toHaveClass('paused');
    expect(row('Feature 3')).not.toHaveClass('paused');
  });

  it('drops a pending keyboard commit when a drag takes over', () => {
    vi.useFakeTimers();
    const capture = vi
      .spyOn(HTMLElement.prototype, 'setPointerCapture')
      .mockImplementation(() => {});
    const release = vi
      .spyOn(HTMLElement.prototype, 'releasePointerCapture')
      .mockImplementation(() => {});
    const { props } = renderTimeline();
    const handle = screen.getByRole('slider', { name: 'End of history' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(handle, { button: 0, pointerId: 1 });
    act(() => {
      vi.runAllTimers();
    });
    // One transaction, where the drag was released; not a second one later.
    expect(props.onRollbackAfterFeature).toHaveBeenCalledTimes(1);
    expect(props.onRollbackAfterFeature).toHaveBeenCalledWith(
      'feature-3',
      'Feature 3'
    );
    capture.mockRestore();
    release.mockRestore();
  });

  it('drops a pending keyboard commit when Resume is pressed', () => {
    vi.useFakeTimers();
    const { props } = renderTimeline({
      features: [feature(1), feature(2), feature(3, undefined, rolledBack)]
    });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'End of history' }), {
      key: 'ArrowDown'
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Resume full history' })
    );
    act(() => {
      vi.runAllTimers();
    });
    // Resume's own transaction only; the keyboard step does not follow it.
    expect(props.onResumeHistory).toHaveBeenCalledTimes(1);
    expect(props.onRollbackAfterFeature).not.toHaveBeenCalled();
  });

  it('drops a pending keyboard commit when a row is rolled back to', () => {
    vi.useFakeTimers();
    const { props } = renderTimeline({
      features: [feature(1), feature(2), feature(3)]
    });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'End of history' }), {
      key: 'ArrowUp'
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Roll back history after Feature 1' })
    );
    act(() => {
      vi.runAllTimers();
    });
    expect(props.onRollbackAfterFeature).toHaveBeenCalledTimes(1);
    expect(props.onRollbackAfterFeature).toHaveBeenCalledWith(
      'feature-1',
      'Feature 1'
    );
  });

  it('drops a pending keyboard commit when a row is reordered', () => {
    vi.useFakeTimers();
    const { props } = renderTimeline();
    fireEvent.keyDown(screen.getByRole('slider', { name: 'End of history' }), {
      key: 'ArrowUp'
    });
    fireEvent.keyDown(
      screen.getByRole('button', {
        name: 'Reorder Feature 2. Use the arrow keys to move it.'
      }),
      { key: 'ArrowDown' }
    );
    act(() => {
      vi.runAllTimers();
    });
    expect(props.onReorderFeature).toHaveBeenCalledWith('feature-2', 2);
    expect(props.onRollbackAfterFeature).not.toHaveBeenCalled();
  });

  it('drops a pending keyboard commit when the history changes under it', () => {
    vi.useFakeTimers();
    const features = [feature(1), feature(2), feature(3)];
    const { props, rerender } = renderTimeline({ features });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'End of history' }), {
      key: 'ArrowUp'
    });
    // An undo or a collaborator reorders the history before the step lands.
    rerender(
      <HistoryTimeline
        {...props}
        features={[features[2]!, features[0]!, features[1]!]}
      />
    );
    act(() => {
      vi.runAllTimers();
    });
    expect(props.onRollbackAfterFeature).not.toHaveBeenCalled();
    expect(props.onResumeHistory).not.toHaveBeenCalled();
  });

  it('re-measures the rows only when something it places changes', () => {
    const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty');
    const { props, rerender } = renderTimeline();
    setProperty.mockClear();
    // The workspace re-renders the browser on every pointer move of a drag;
    // a render that changes nothing on the line must not force a layout.
    rerender(<HistoryTimeline {...props} hiddenBodyIds={new Set()} />);
    expect(setProperty).not.toHaveBeenCalledWith(
      '--spine-height',
      expect.anything()
    );
    rerender(<HistoryTimeline {...props} selectedFeatureNodeId="node-2" />);
    expect(setProperty).toHaveBeenCalledWith('--highlight-opacity', '1');
    setProperty.mockRestore();
  });

  it('resumes when the handle is moved back to the end', () => {
    vi.useFakeTimers();
    const { props } = renderTimeline({
      features: [feature(1), feature(2), feature(3, undefined, rolledBack)]
    });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'End of history' }), {
      key: 'End'
    });
    act(() => {
      vi.runAllTimers();
    });
    expect(props.onResumeHistory).toHaveBeenCalledTimes(1);
    expect(props.onRollbackAfterFeature).not.toHaveBeenCalled();
  });

  it('walks the selection with the arrow keys', () => {
    const { props } = renderTimeline({ selectedFeatureNodeId: 'node-2' });
    const main = row('Feature 2').querySelector('.feature-row-main')!;
    fireEvent.keyDown(main, { key: 'ArrowDown' });
    expect(props.onSelectFeature).toHaveBeenCalledWith('node-3');
    fireEvent.keyDown(main, { key: 'ArrowUp' });
    expect(props.onSelectFeature).toHaveBeenCalledWith('node-1');
  });

  it('keeps walking the rows while the edit card takes focus on each selection', async () => {
    // The inspector hands the selected feature's edit panel the keyboard in
    // an effect, after the keydown that made the selection. The walk used to
    // stop there: the second arrow key went to the panel, not the list.
    function Workspace() {
      const [selected, setSelected] = useState<string | null>('node-1');
      const panel = useRef<HTMLElement>(null);
      useEffect(() => {
        panel.current?.focus();
      }, [selected]);
      return (
        <>
          <HistoryTimeline
            {...timelineProps()}
            selectedFeatureNodeId={selected}
            onSelectFeature={setSelected}
          />
          <section ref={panel} tabIndex={-1} aria-label="Feature inspector" />
        </>
      );
    }
    const user = userEvent.setup();
    render(<Workspace />);
    const main = (name: string) =>
      row(name).querySelector<HTMLElement>('.feature-row-main')!;
    act(() => main('Feature 1').focus());

    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(document.activeElement).toBe(main('Feature 2')));
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(document.activeElement).toBe(main('Feature 3')));
    expect(row('Feature 3')).toHaveClass('selected');
  });

  it('keeps the rest of a double-click on the row that opened the edit card', () => {
    // Selecting a row opens its edit card above the list and pushes the row
    // ~270 px down, so the second press landed on the card's Operation
    // select and the next letter typed turned New body into Cut. Without a
    // layout the card's controls stand in for what moved under the pointer.
    const onOperationPress = vi.fn();
    const onApply = vi.fn();
    function Workspace() {
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <>
          {selected ? (
            <form aria-label="Edit card">
              <select
                aria-label="Operation"
                defaultValue="new-body"
                onMouseDown={onOperationPress}
              >
                <option value="new-body">New body</option>
                <option value="cut">Cut</option>
              </select>
              <button type="button" onClick={onApply}>
                Apply
              </button>
            </form>
          ) : null}
          <HistoryTimeline
            {...timelineProps()}
            selectedFeatureNodeId={selected}
            onSelectFeature={setSelected}
          />
        </>
      );
    }
    render(<Workspace />);
    const main =
      row('Feature 2').querySelector<HTMLElement>('.feature-row-main')!;
    fireEvent.mouseDown(main, { detail: 1 });
    fireEvent.click(main, { detail: 1 });
    expect(row('Feature 2')).toHaveClass('selected');

    const operation = screen.getByRole('combobox', { name: 'Operation' });
    // fireEvent returns false when the default was prevented: no focus, no
    // open list for a letter to pick from.
    expect(fireEvent.mouseDown(operation, { detail: 2 })).toBe(false);
    expect(onOperationPress).not.toHaveBeenCalled();
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(fireEvent.click(apply, { detail: 2 })).toBe(false);
    fireEvent.dblClick(apply, { detail: 2 });
    expect(onApply).not.toHaveBeenCalled();

    // The next single press is the user's own again.
    expect(fireEvent.mouseDown(apply, { detail: 1 })).toBe(true);
    fireEvent.click(apply, { detail: 1 });
    expect(onApply).toHaveBeenCalledOnce();
  });

  it('lets a double-click that stays on its row through as one selection', () => {
    const { props } = renderTimeline();
    const main =
      row('Feature 2').querySelector<HTMLElement>('.feature-row-main')!;
    fireEvent.mouseDown(main, { detail: 1 });
    fireEvent.click(main, { detail: 1 });
    expect(fireEvent.mouseDown(main, { detail: 2 })).toBe(true);
    fireEvent.click(main, { detail: 2 });
    fireEvent.dblClick(main, { detail: 2 });
    // The second click is the rest of the gesture, not a second toggle.
    expect(props.onSelectFeature).toHaveBeenCalledOnce();
    expect(props.onSelectFeature).toHaveBeenCalledWith('node-2');
    // Ends the hold, as the user's next single press would.
    fireEvent.mouseDown(document.body, { detail: 1 });
  });

  it('keeps a double-clicked row selected when its edit card opens elsewhere', () => {
    // The edit card stands in the right lane, away from History, so the
    // row stays under the pointer; selecting a selected row clears it, and
    // the second click closed the card the first had opened.
    function Workspace() {
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <HistoryTimeline
          {...timelineProps()}
          selectedFeatureNodeId={selected}
          onSelectFeature={(id) =>
            setSelected((current) => (current === id ? null : id))
          }
        />
      );
    }
    render(<Workspace />);
    const main =
      row('Feature 2').querySelector<HTMLElement>('.feature-row-main')!;
    fireEvent.mouseDown(main, { detail: 1 });
    fireEvent.click(main, { detail: 1 });
    fireEvent.mouseDown(main, { detail: 2 });
    fireEvent.click(main, { detail: 2 });
    fireEvent.dblClick(main, { detail: 2 });
    expect(row('Feature 2')).toHaveClass('selected');
    // A later single click is the user's own: it clears the row again.
    fireEvent.mouseDown(main, { detail: 1 });
    fireEvent.click(main, { detail: 1 });
    expect(row('Feature 2')).not.toHaveClass('selected');
    fireEvent.mouseDown(document.body, { detail: 1 });
  });

  it('filters by name and marks the match', async () => {
    const user = userEvent.setup();
    const { container, props } = renderTimeline({
      findOpen: true,
      features: [feature(1), { ...feature(2), name: 'Base fillet' }, feature(3)]
    });
    await user.type(
      screen.getByRole('searchbox', { name: 'Find a step' }),
      'fil'
    );
    expect(container.querySelectorAll('.feature-row')).toHaveLength(1);
    expect(container.querySelector('.history-match')).toHaveTextContent('fil');
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    // Filtering hides the handle: a boundary between filtered rows means nothing.
    expect(screen.queryByRole('slider')).toBeNull();
    await user.keyboard('{Escape}');
    expect(props.onCloseFind).toHaveBeenCalledTimes(1);
  });

  it('narrows to the steps related to the selection, alongside the text filter', async () => {
    const user = userEvent.setup();
    const related = new Set([
      'feature-1',
      'feature-3',
      'feature-4'
    ] as FeatureId[]);
    const { container, rerender, props } = renderTimeline({
      findOpen: true,
      relatedFeatureIds: related
    });
    const toggle = screen.getByRole('button', { name: 'Related' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelectorAll('.feature-row')).toHaveLength(3);
    expect(screen.getByText('3 of 4')).toBeInTheDocument();
    // Hidden rows sit between the related ones, so reordering is off while
    // the list is filtered: a step could otherwise move past an invisible one.
    const grip = screen.getByRole('button', {
      name: 'Reorder Feature 1. Use the arrow keys to move it.'
    });
    expect(grip).toBeDisabled();
    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    expect(props.onReorderFeature).not.toHaveBeenCalled();
    // The two filters combine.
    await user.type(
      screen.getByRole('searchbox', { name: 'Find a step' }),
      'Feature 4'
    );
    expect(container.querySelectorAll('.feature-row')).toHaveLength(1);
    // Clearing the selection disables the toggle and restores every row
    // the text filter allows, rather than emptying the list.
    rerender(<HistoryTimeline {...props} findOpen relatedFeatureIds={null} />);
    expect(screen.getByRole('button', { name: 'Related' })).toBeDisabled();
    await user.clear(screen.getByRole('searchbox', { name: 'Find a step' }));
    expect(container.querySelectorAll('.feature-row')).toHaveLength(4);
    // A new selection does not re-filter on its own: Related stays off
    // until it is pressed again.
    rerender(
      <HistoryTimeline {...props} findOpen relatedFeatureIds={related} />
    );
    expect(screen.getByRole('button', { name: 'Related' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(container.querySelectorAll('.feature-row')).toHaveLength(4);
  });

  it('opens the feature menu from the row', async () => {
    const user = userEvent.setup();
    const { props } = renderTimeline();
    await user.click(
      screen.getByRole('button', { name: 'More actions for Feature 2' })
    );
    const [at, target] = vi.mocked(props.onFeatureContextMenu).mock.calls[0]!;
    expect(typeof at.clientX).toBe('number');
    expect(target.id).toBe('node-2');
  });

  it('hands the row menu the same roll-back and resume the row buttons run', () => {
    const { props } = renderTimeline({
      features: [feature(1), feature(2), feature(3, undefined, rolledBack)]
    });
    const menuFor = (name: string) => {
      fireEvent.contextMenu(row(name));
      return vi.mocked(props.onFeatureContextMenu).mock.calls.at(-1)![2]!;
    };
    // Rolled back to just after Feature 2: its menu resumes instead.
    expect(menuFor('Feature 2').endOfHistory).toBe('marker');
    menuFor('Feature 2').resume();
    expect(props.onResumeHistory).toHaveBeenCalledTimes(1);
    const first = menuFor('Feature 1');
    expect(first.endOfHistory).toBeNull();
    first.rollBack();
    expect(props.onRollbackAfterFeature).toHaveBeenCalledWith(
      'feature-1',
      'Feature 1'
    );
    // No rename without a handler for it.
    expect(first.rename).toBeUndefined();
  });

  it('marks the last row when nothing is rolled back', () => {
    const { props } = renderTimeline();
    fireEvent.contextMenu(row('Feature 4'));
    expect(
      vi.mocked(props.onFeatureContextMenu).mock.calls[0]![2]!.endOfHistory
    ).toBe('last');
  });

  it('renames in place from the row menu: Enter keeps, Escape cancels', async () => {
    const user = userEvent.setup();
    const onRenameFeature = vi.fn();
    const { props } = renderTimeline({ onRenameFeature });
    const renameFrom = (name: string) => {
      fireEvent.contextMenu(row(name));
      act(() =>
        vi.mocked(props.onFeatureContextMenu).mock.calls.at(-1)![2]!.rename!()
      );
    };

    renameFrom('Feature 2');
    const field = screen.getByRole('textbox', { name: 'Rename Feature 2' });
    await waitFor(() => expect(field).toHaveFocus());
    await user.clear(field);
    await user.type(field, '  Boss  {Enter}');
    expect(onRenameFeature).toHaveBeenCalledTimes(1);
    expect(onRenameFeature).toHaveBeenCalledWith('feature-2', 'Boss');
    expect(screen.queryByRole('textbox')).toBeNull();

    renameFrom('Feature 3');
    const other = screen.getByRole('textbox', { name: 'Rename Feature 3' });
    await user.type(other, 'x{Escape}');
    expect(onRenameFeature).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox')).toBeNull();

    // An empty or unchanged name is no edit.
    renameFrom('Feature 1');
    fireEvent.blur(screen.getByRole('textbox', { name: 'Rename Feature 1' }));
    expect(onRenameFeature).toHaveBeenCalledTimes(1);
  });

  it('keeps a Show button on a hidden sketch', async () => {
    const user = userEvent.setup();
    const { props } = renderTimeline({
      features: [feature(1, { featureKind: 'sketch', sketchId: 'sketch-1' })],
      hiddenSketchIds: new Set(['sketch-1'])
    });
    await user.click(screen.getByRole('button', { name: 'Show Feature 1' }));
    expect(props.onToggleSketchVisibility).toHaveBeenCalledWith('sketch-1');
  });
});

it('flags a sketch whose linked projection lost its source edge (I01)', () => {
  const sketch = feature(1, { featureKind: 'sketch', sketchId: 'sketch_s' });
  const { rerender, props } = renderTimeline({
    features: [sketch, feature(2)],
    brokenProjectionSketchIds: new Set(['sketch_s'])
  });
  expect(screen.getByText('broken projection')).toBeInTheDocument();
  expect(
    row('Feature 1').querySelector('.feature-flag.error')
  ).toHaveAttribute('title', expect.stringMatching(/re-pick or unlink/));
  // Pending geometry has no verdict yet; nothing is called broken.
  rerender(<HistoryTimeline {...props} geometryPending />);
  expect(screen.queryByText('broken projection')).not.toBeInTheDocument();
});
