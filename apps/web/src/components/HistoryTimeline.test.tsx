import {
  act,
  fireEvent,
  render,
  screen,
  within,
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
import {
  featureIcon,
  findRollbackMarkerIndex,
  HistoryTimeline,
  placeTimeline
} from './HistoryTimeline';

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

/** Scrolls the history list up from its foot, where the latest row sits. */
function scrollListAwayFromLatest() {
  const list = document.querySelector('.feature-list') as HTMLElement;
  Object.defineProperty(list, 'scrollHeight', {
    configurable: true,
    value: 600
  });
  Object.defineProperty(list, 'clientHeight', {
    configurable: true,
    value: 200
  });
  list.scrollTop = 0;
  fireEvent.scroll(list);
}

function row(name: string): HTMLElement {
  return screen.getByText(name).closest('.feature-row') as HTMLElement;
}

it('acts on the latest node of a row that skipped re-rendering', () => {
  const { props, rerender } = renderTimeline();
  const grip = within(row('Feature 2')).getByRole('button', {
    name: 'Reorder Feature 2. Use the arrow keys to move it.'
  });
  // An edit replaces every node object; rows whose rendered inputs are
  // unchanged keep their DOM, and their handlers must still see the new node.
  const next = props.features.map((node) => structuredClone(node));
  rerender(<HistoryTimeline {...props} features={next} />);
  expect(
    within(row('Feature 2')).getByRole('button', {
      name: 'Reorder Feature 2. Use the arrow keys to move it.'
    })
  ).toBe(grip);
  fireEvent.click(screen.getByRole('button', { name: 'Suppress Feature 2' }));
  // The very object, not an equal one: a clone of the old node would pass
  // a deep comparison.
  expect(vi.mocked(props.onToggleFeatureSuppression).mock.calls[0]![0]).toBe(
    next[1]
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Roll back history after Feature 2' })
  );
  expect(props.onRollbackAfterFeature).toHaveBeenCalledWith(
    'feature-2',
    'Feature 2'
  );
  fireEvent.contextMenu(row('Feature 3'));
  expect(vi.mocked(props.onFeatureContextMenu).mock.lastCall![1]).toBe(next[2]);
});

it('opens a sketch row for editing on double-click, and only a sketch row (I36)', () => {
  const onEditSketch = vi.fn();
  const sketchRow = {
    ...feature(2, { featureKind: 'sketch', sketchId: 'sketch_1' }),
    name: 'Base sketch'
  } as FeatureNode;
  renderTimeline({
    features: [feature(1), sketchRow],
    onEditSketch
  });
  fireEvent.doubleClick(
    within(row('Feature 1')).getByRole('button', { name: /^Feature 1/ })
  );
  expect(onEditSketch).not.toHaveBeenCalled();
  fireEvent.doubleClick(
    within(row('Base sketch')).getByRole('button', { name: /^Base sketch/ })
  );
  expect(onEditSketch).toHaveBeenCalledWith(sketchRow);
});

it('re-renders a row whose name changed under the same node id', () => {
  const { props, rerender } = renderTimeline();
  const renamed = props.features.map((node, index) =>
    index === 1 ? { ...node, name: 'Renamed step' } : node
  );
  rerender(<HistoryTimeline {...props} features={renamed} />);
  expect(screen.getByText('Renamed step')).toBeInTheDocument();
  expect(screen.queryByText('Feature 2')).toBeNull();
});

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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('HistoryTimeline', () => {
  it('shows a refused operation as a transient row that is not a step', () => {
    const { container, rerender, props } = renderTimeline({
      pendingStep: {
        title: 'Fillet',
        message: 'Fillet could not be created on the selected closed edge.'
      }
    });
    const pending = screen.getByRole('status');
    expect(pending).toHaveTextContent('Fillet');
    expect(pending).toHaveTextContent('not built');
    expect(pending).toHaveAttribute(
      'title',
      'Fillet could not be created on the selected closed edge.'
    );
    // Not a row: the handle, the keyboard walk and the count skip it.
    expect(container.querySelectorAll('.feature-row')).toHaveLength(4);
    expect(pending.closest('.feature-list')).toBeNull();
    rerender(<HistoryTimeline {...props} pendingStep={null} />);
    expect(container.querySelector('.history-pending-row')).toBeNull();
  });

  it('says a refused edit of an existing step on that step, not as a new one', () => {
    // Resize Body edits its Box: a refusal is about the Box row, and there is
    // no new step that could have been "not built".
    const { container, rerender, props } = renderTimeline({
      selectedFeatureNodeId: 'node-2',
      editingFeatureId: 'feature-2',
      pendingStep: {
        title: 'Resize Body',
        message: '“Chamfer” can’t follow this change.'
      }
    });
    expect(container.querySelector('.history-pending-row')).toBeNull();
    const edited = row('Feature 2');
    expect(edited).toHaveClass('is-editing');
    const flag = edited.querySelector('.history-row-refused');
    expect(flag).toHaveTextContent('edit not applied');
    expect(flag).toHaveAttribute(
      'title',
      'Resize Body not applied: “Chamfer” can’t follow this change.'
    );
    expect(container.querySelectorAll('.history-row-refused')).toHaveLength(1);
    // Still editing, nothing refused: the row is marked, with no flag.
    rerender(<HistoryTimeline {...props} pendingStep={null} />);
    expect(row('Feature 2')).toHaveClass('is-editing');
    expect(container.querySelector('.history-row-refused')).toBeNull();
    // A step the command would add still reads as a trailing pending row.
    rerender(
      <HistoryTimeline
        {...props}
        editingFeatureId={null}
        pendingStep={{ title: 'Offset Face', message: 'Refused.' }}
      />
    );
    expect(container.querySelector('.history-pending-row')).not.toBeNull();
    expect(row('Feature 2')).not.toHaveClass('is-editing');
  });

  it('names a Boolean row by the bodies it combined', () => {
    renderTimeline({
      features: [
        feature(1, {
          featureKind: 'boolean',
          operation: 'union',
          targetBodyIds: ['body_box', 'body_cylinder']
        })
      ],
      representations: {
        body_box: { name: 'Box 1' },
        body_cylinder: { name: 'Cylinder 1' }
      } as unknown as ComponentProps<typeof HistoryTimeline>['representations']
    });
    expect(screen.getByText('Box 1 + Cylinder 1')).toBeInTheDocument();
  });

  it('puts the value beside the name in the row tooltip, whole', () => {
    renderTimeline({
      features: [
        feature(1, {
          featureKind: 'thread',
          profile: 'printable',
          majorDiameter: 12,
          pitch: 1.75
        })
      ]
    });
    expect(row('Feature 1').querySelector('.feature-row-main')).toHaveAttribute(
      'title',
      'Feature 1 — Thread (⌀ 12 × 1.75 mm, printable), click to edit'
    );
  });

  it('offers Show latest operation only while the latest row is scrolled away', () => {
    renderTimeline();
    // Every row fits: the latest is already in view.
    expect(
      screen.queryByRole('button', { name: 'Show latest operation' })
    ).not.toBeInTheDocument();
    scrollListAwayFromLatest();
    const latest = screen.getByRole('button', {
      name: 'Show latest operation'
    });
    expect(latest).toHaveTextContent('Latest');
    // At the foot, where the end is: after the list, not above the rows.
    expect(
      document.querySelector('.feature-list')!.compareDocumentPosition(latest) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // Scrolled back to the foot, it goes again.
    const list = document.querySelector('.feature-list') as HTMLElement;
    list.scrollTop = 400;
    fireEvent.scroll(list);
    expect(
      screen.queryByRole('button', { name: 'Show latest operation' })
    ).not.toBeInTheDocument();
  });

  it('measures the latest row against the panel, not the details below the list', () => {
    const host = document.createElement('div');
    host.className = 'model-panel-body';
    document.body.append(host);
    render(<HistoryTimeline {...timelineProps()} />, { container: host });
    // The History details follow the list in the same scroller: the scroller
    // has more below, but the list's end is in view.
    Object.defineProperty(host, 'scrollHeight', {
      configurable: true,
      value: 600
    });
    Object.defineProperty(host, 'clientHeight', {
      configurable: true,
      value: 200
    });
    const list = host.querySelector('.feature-list') as HTMLElement;
    let listBottom = 150;
    vi.spyOn(list, 'getBoundingClientRect').mockImplementation(
      () => ({ bottom: listBottom }) as DOMRect
    );
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 0 }) as DOMRect
    );
    fireEvent.scroll(host);
    expect(
      screen.queryByRole('button', { name: 'Show latest operation' })
    ).toBeNull();
    listBottom = 400;
    fireEvent.scroll(host);
    expect(
      screen.getByRole('button', { name: 'Show latest operation' })
    ).toBeInTheDocument();
    host.remove();
  });

  it('reveals the latest appended operation without changing the edited selection', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const { props, rerender } = renderTimeline({
      selectedFeatureNodeId: 'node-1'
    });
    const scroll = vi.fn();
    rerender(
      <HistoryTimeline {...props} features={[...props.features, feature(5)]} />
    );
    scrollListAwayFromLatest();
    row('Feature 5').scrollIntoView = scroll;
    fireEvent.click(
      screen.getByRole('button', { name: 'Show latest operation' })
    );
    frames.splice(0).forEach((frame) => frame(0));
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    expect(props.onSelectFeature).not.toHaveBeenCalled();
    expect(row('Feature 1')).toHaveClass('selected');
    vi.restoreAllMocks();
  });

  it('follows a successful local append without changing the selected publisher', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const { props, rerender } = renderTimeline({
      selectedFeatureNodeId: 'node-1'
    });
    rerender(
      <HistoryTimeline
        {...props}
        features={[...props.features, feature(5)]}
        localAppend={{ projectId: 'history', nodeId: 'node-5', version: 5 }}
      />
    );
    const scroll = vi.fn();
    row('Feature 5').scrollIntoView = scroll;
    frames.splice(0).forEach((frame) => frame(0));
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    expect(props.onSelectFeature).not.toHaveBeenCalled();
    expect(row('Feature 1')).toHaveClass('selected');
    vi.restoreAllMocks();
  });

  it('keeps a user browsing older history in place and offers the actual new operation', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const { props, rerender, container } = renderTimeline();
    const list = container.querySelector('.feature-list')!;
    Object.defineProperties(list, {
      scrollHeight: { value: 500 },
      clientHeight: { value: 100 },
      scrollTop: { value: 0, writable: true }
    });
    fireEvent.scroll(list);
    rerender(
      <HistoryTimeline
        {...props}
        features={[...props.features, feature(5)]}
        localAppend={{ projectId: 'history', nodeId: 'node-5', version: 5 }}
      />
    );
    const scroll = vi.fn();
    row('Feature 5').scrollIntoView = scroll;
    frames.splice(0).forEach((frame) => frame(0));
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Show new operation: Feature 5' })
    );
    frames.splice(0).forEach((frame) => frame(0));
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    expect(props.onSelectFeature).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('preserves the filter and focus until the new-operation reveal is requested', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const { props, rerender } = renderTimeline({ findOpen: true });
    const input = screen.getByRole('searchbox', { name: 'Find a step' });
    input.focus();
    fireEvent.change(input, { target: { value: 'Feature 1' } });
    rerender(
      <HistoryTimeline
        {...props}
        features={[...props.features, feature(5)]}
        localAppend={{ projectId: 'history', nodeId: 'node-5', version: 5 }}
      />
    );
    frames.splice(0).forEach((frame) => frame(0));
    expect(input).toHaveValue('Feature 1');
    expect(input).toHaveFocus();
    expect(screen.queryByText('Feature 5')).toBeNull();
    expect(props.onCloseFind).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Show new operation: Feature 5' })
    );
    const scroll = vi.fn();
    row('Feature 5').scrollIntoView = scroll;
    frames.splice(0).forEach((frame) => frame(0));
    expect(input).toHaveValue('');
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    expect(props.onSelectFeature).not.toHaveBeenCalled();
  });

  it('keeps the unseen local target through a peer append and drops it on undo', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const { props, rerender, container } = renderTimeline();
    const list = container.querySelector('.feature-list')!;
    Object.defineProperties(list, {
      scrollHeight: { value: 500 },
      clientHeight: { value: 100 },
      scrollTop: { value: 0, writable: true }
    });
    fireEvent.scroll(list);
    const signal = { projectId: 'history', nodeId: 'node-5', version: 5 };
    rerender(
      <HistoryTimeline
        {...props}
        features={[...props.features, feature(5)]}
        localAppend={signal}
      />
    );
    rerender(
      <HistoryTimeline
        {...props}
        features={[...props.features, feature(5), feature(6)]}
        localAppend={signal}
      />
    );
    const localScroll = vi.fn();
    row('Feature 5').scrollIntoView = localScroll;
    const remoteScroll = vi.fn();
    row('Feature 6').scrollIntoView = remoteScroll;
    fireEvent.click(
      screen.getByRole('button', { name: 'Show new operation: Feature 5' })
    );
    frames.splice(0).forEach((frame) => frame(0));
    expect(localScroll).toHaveBeenCalledOnce();
    expect(remoteScroll).not.toHaveBeenCalled();
    fireEvent.wheel(list);
    fireEvent.scroll(list);
    const nextSignal = { ...signal, version: 7, nodeId: 'node-7' };
    rerender(
      <HistoryTimeline
        {...props}
        features={[...props.features, feature(7)]}
        localAppend={nextSignal}
      />
    );
    expect(
      screen.getByRole('button', { name: 'Show new operation: Feature 7' })
    ).toBeInTheDocument();
    rerender(<HistoryTimeline {...props} localAppend={nextSignal} />);
    expect(
      screen.queryByRole('button', { name: /Show new operation:/ })
    ).toBeNull();
    rerender(
      <HistoryTimeline
        {...props}
        features={[...props.features, feature(7)]}
        localAppend={nextSignal}
      />
    );
    expect(
      screen.queryByRole('button', { name: /Show new operation:/ })
    ).toBeNull();
  });

  it('does not follow a remote append without a local commit signal', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const { props, rerender } = renderTimeline();
    rerender(
      <HistoryTimeline {...props} features={[...props.features, feature(5)]} />
    );
    const scroll = vi.fn();
    row('Feature 5').scrollIntoView = scroll;
    frames.splice(0).forEach((frame) => frame(0));
    expect(scroll).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: /Show new operation/ })
    ).toBeNull();
  });

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

  it('tells the first failure from the failures and builds that follow it', () => {
    const features = [
      feature(1),
      feature(2),
      feature(3),
      feature(4),
      feature(5)
    ];
    renderTimeline({
      features,
      failedFeatureIds: new Set([
        features[1]!.featureId,
        features[3]!.featureId
      ]),
      // Feature 2 fails first; Feature 3 builds on it and Feature 4 fails
      // after it. Feature 5 is on another branch.
      failureLineage: new Map([
        [features[2]!.featureId, features[1]!],
        [features[3]!.featureId, features[1]!]
      ])
    });
    expect(row('Feature 2')).toHaveClass('failed', 'is-failure-root');
    expect(row('Feature 2')).toHaveTextContent(/needs repair, first failure/);
    expect(row('Feature 4')).toHaveClass('failed', 'is-failure-downstream');
    expect(row('Feature 4')).toHaveTextContent(
      /needs repair, after an earlier failure/
    );
    expect(row('Feature 4').querySelector('.feature-row-main')).toHaveAttribute(
      'title',
      'Feature 4 — Extrude (4 mm), needs repair after “Feature 2” failed, click to edit'
    );
    expect(row('Feature 3')).toHaveClass('is-built-on-failed');
    expect(row('Feature 3')).not.toHaveClass('failed');
    expect(row('Feature 3')).toHaveTextContent('built on a failed step');
    expect(row('Feature 3').querySelector('.feature-row-main')).toHaveAttribute(
      'title',
      expect.stringContaining('built on “Feature 2”, which failed')
    );
    // Only a failure carries the warning glyph; a build on one has none.
    expect(
      row('Feature 2').querySelector('.feature-flag.error')
    ).not.toBeNull();
    expect(row('Feature 3').querySelector('.feature-flag.error')).toBeNull();
    for (const name of ['Feature 1', 'Feature 5']) {
      expect(row(name).className).not.toMatch(/failure|built-on-failed|failed/);
      expect(row(name)).not.toHaveTextContent(/repair|failed/);
    }
  });

  it('keeps the value on a failed, suppressed, paused or preparing row', () => {
    const failing = feature(2);
    failing.bodyId = 'body-missing' as FeatureNode['bodyId'];
    const features = [
      feature(1, undefined, { [FEATURE_SUPPRESSED_METADATA_KEY]: true }),
      failing,
      feature(3, undefined, rolledBack)
    ];
    const { rerender, props } = renderTimeline({ features });
    const value = (name: string) =>
      row(name).querySelector('.history-row-value');
    expect(value('Feature 1')).toHaveTextContent('1 mm');
    expect(value('Feature 2')).toHaveTextContent('2 mm');
    expect(value('Feature 3')).toHaveTextContent('3 mm');
    // The state is said after the name, never in the value's place.
    expect(row('Feature 1')).toHaveTextContent(/^Feature 1 suppressed/);
    expect(row('Feature 2')).toHaveTextContent(/^Feature 2 needs repair/);
    expect(row('Feature 3')).toHaveTextContent(/^Feature 3 paused/);
    expect(
      row('Feature 2').querySelector('.feature-row-main')
    ).toHaveAccessibleName(/^Feature 2 needs repair.*first failure$/);
    rerender(<HistoryTimeline {...props} geometryPending />);
    expect(value('Feature 2')).toHaveTextContent('2 mm');
    expect(row('Feature 2')).toHaveTextContent(/^Feature 2 preparing/);
    expect(row('Feature 2')).toHaveClass('is-preparing');
  });

  it('wears the icon of the command that made each step', () => {
    renderTimeline({
      features: [
        feature(1, { featureKind: 'fillet', radius: 1 }),
        feature(2, {
          featureKind: 'direct-edit',
          operation: { kind: 'offset-face', offset: 2 }
        }),
        feature(3, {
          featureKind: 'direct-edit',
          operation: { kind: 'resize-cylindrical-face', radius: 3 }
        }),
        feature(4, {
          featureKind: 'boolean',
          operation: 'subtract',
          targetBodyIds: []
        })
      ]
    });
    const icon = (name: string) =>
      row(name).querySelector('.feature-row-grip .feature-icon svg');
    expect(icon('Feature 1')).toHaveClass('lucide-radius');
    expect(icon('Feature 2')).toHaveClass('lucide-arrow-up-from-dot');
    expect(icon('Feature 3')).toHaveClass('lucide-diameter');
    expect(icon('Feature 4')).toHaveClass('lucide-squares-subtract');
  });

  it('selects the row from a click on its icon, and reorders only on a drag', () => {
    const { props } = renderTimeline();
    const grip = within(row('Feature 2')).getByRole('button', {
      name: 'Reorder Feature 2. Use the arrow keys to move it.'
    });
    fireEvent.click(grip, { detail: 1 });
    expect(props.onSelectFeature).toHaveBeenCalledWith('node-2');
    // Enter on the grip is not a selection: the grip's keys reorder.
    fireEvent.click(grip, { detail: 0 });
    expect(props.onSelectFeature).toHaveBeenCalledTimes(1);
    expect(props.onReorderFeature).not.toHaveBeenCalled();
  });

  it('narrows to the problem rows with Problems, alongside the text filter', async () => {
    const user = userEvent.setup();
    const features = [feature(1), feature(2), feature(3), feature(4)];
    const { container, rerender, props } = renderTimeline({
      findOpen: true,
      features,
      failedFeatureIds: new Set([features[1]!.featureId]),
      failureLineage: new Map([[features[2]!.featureId, features[1]!]])
    });
    const toggle = screen.getByRole('button', { name: 'Problems' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // The failure and the step built on it.
    expect(
      [...container.querySelectorAll('.feature-row .feature-name')].map(
        (name) => name.textContent
      )
    ).toEqual(['Feature 2', 'Feature 3']);
    expect(screen.getByText('2 of 4')).toBeInTheDocument();
    await user.type(
      screen.getByRole('searchbox', { name: 'Find a step' }),
      'Feature 3'
    );
    expect(container.querySelectorAll('.feature-row')).toHaveLength(1);
    // Repaired: the toggle turns off and disables rather than emptying the list.
    rerender(
      <HistoryTimeline
        {...props}
        failedFeatureIds={new Set()}
        failureLineage={new Map()}
      />
    );
    expect(screen.getByRole('button', { name: 'Problems' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Problems' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await user.clear(screen.getByRole('searchbox', { name: 'Find a step' }));
    expect(container.querySelectorAll('.feature-row')).toHaveLength(4);
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

  it('holds Resume while an exact check is running', () => {
    const { props } = renderTimeline({
      features: [feature(1), feature(2, undefined, rolledBack)],
      reorderBusy: true
    });
    const resume = screen.getByRole('button', { name: 'Resume full history' });
    expect(resume).toBeDisabled();
    expect(resume).toHaveTextContent('Checking…');
    fireEvent.click(resume);
    expect(props.onResumeHistory).not.toHaveBeenCalled();
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

  it('holds the reorder grip while an exact operation is running', () => {
    const { props, rerender } = renderTimeline({ reorderBusy: true });
    const grip = screen.getByRole('button', {
      name: 'Reorder Feature 2. Use the arrow keys to move it.'
    });
    // Repeated presses during a rebuild used to be refused one by one and
    // could leave an order nobody chose; now none goes out, and focus stays.
    grip.focus();
    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    expect(props.onReorderFeature).not.toHaveBeenCalled();
    expect(grip).toHaveAttribute('aria-disabled', 'true');
    expect(grip).not.toBeDisabled();
    expect(grip).toHaveFocus();
    rerender(<HistoryTimeline {...props} reorderBusy={false} />);
    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    expect(props.onReorderFeature).toHaveBeenCalledWith('feature-2', 2);
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
    // A browser reports a new observation after layout, before paint; the
    // stub delivers it on demand, as that frame would.
    const pending: (() => void)[] = [];
    class FrameResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        pending.push(() => this.callback([], this));
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FrameResizeObserver);
    const frame = () => pending.splice(0).forEach((report) => report());
    const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty');
    try {
      const { props, rerender } = renderTimeline();
      frame();
      setProperty.mockClear();
      // The workspace re-renders the browser on every pointer move of a drag;
      // a render that changes nothing on the line must not force a layout.
      rerender(<HistoryTimeline {...props} hiddenBodyIds={new Set()} />);
      frame();
      expect(setProperty).not.toHaveBeenCalled();
      rerender(<HistoryTimeline {...props} selectedFeatureNodeId="node-2" />);
      // Not inside the commit: the placement waits for the frame's layout.
      expect(setProperty).not.toHaveBeenCalled();
      frame();
      expect(setProperty).toHaveBeenCalledWith('--highlight-opacity', '1');
    } finally {
      setProperty.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('measures every row before placing anything', () => {
    // A placed property restyles the rows, so a read after a write would
    // force another style and layout pass.
    const list = document.createElement('div');
    list.dataset.end = '1';
    list.dataset.last = '1';
    const events: string[] = [];
    for (const index of [0, 1]) {
      const row = document.createElement('div');
      row.className = index === 1 ? 'feature-row selected' : 'feature-row';
      row.dataset.historyIndex = String(index);
      Object.defineProperty(row, 'offsetTop', {
        get: () => (events.push('read'), index * 40)
      });
      Object.defineProperty(row, 'offsetHeight', {
        get: () => (events.push('read'), 40)
      });
      list.append(row);
    }
    const setProperty = vi
      .spyOn(list.style, 'setProperty')
      .mockImplementation(() => void events.push('write'));
    placeTimeline(list);
    expect(events.indexOf('write')).toBeGreaterThan(events.lastIndexOf('read'));
    expect(setProperty).toHaveBeenCalledWith('--spine-top', '20px');
    expect(setProperty).toHaveBeenCalledWith('--spine-height', '40px');
    expect(setProperty).toHaveBeenCalledWith('--handle-y', '80px');
    expect(setProperty).toHaveBeenCalledWith('--fill-height', '40px');
    expect(setProperty).toHaveBeenCalledWith('--highlight-y', '40px');
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

  describe('multi-row selection', () => {
    const rowButton = (name: string) =>
      row(name).querySelector('.feature-row-main') as HTMLElement;

    it('selects a range with Shift-click and deletes it with Delete', () => {
      const onDeleteFeatures = vi.fn();
      const { props } = renderTimeline({ onDeleteFeatures });
      fireEvent.click(rowButton('Feature 1'));
      expect(props.onSelectFeature).toHaveBeenLastCalledWith('node-1');
      fireEvent.click(rowButton('Feature 3'), { shiftKey: true });
      expect(
        screen.getByRole('toolbar', { name: 'Selected steps' })
      ).toHaveTextContent('3 selected');
      expect(row('Feature 2')).toHaveClass('in-batch');
      expect(row('Feature 4')).not.toHaveClass('in-batch');
      fireEvent.keyDown(rowButton('Feature 3'), { key: 'Delete' });
      expect(onDeleteFeatures).toHaveBeenCalledWith([
        'feature-1',
        'feature-2',
        'feature-3'
      ]);
    });

    it('seeds the batch from the single selection and releases it', () => {
      const onSelectFeature = vi.fn();
      renderTimeline({
        onDeleteFeatures: vi.fn(),
        selectedFeatureNodeId: 'node-2',
        onSelectFeature
      });
      fireEvent.click(rowButton('Feature 4'), { shiftKey: true });
      // Toggling the selected row clears it, so no edit card stays open
      // on one step of several.
      expect(onSelectFeature).toHaveBeenCalledWith('node-2');
      expect(
        ['Feature 2', 'Feature 3', 'Feature 4'].every((name) =>
          row(name).classList.contains('in-batch')
        )
      ).toBe(true);
    });

    it('adds and drops rows with Ctrl/⌘-click and deletes from the bar', () => {
      const onDeleteFeatures = vi.fn();
      renderTimeline({ onDeleteFeatures });
      fireEvent.click(rowButton('Feature 1'), { ctrlKey: true });
      fireEvent.click(rowButton('Feature 4'), { metaKey: true });
      fireEvent.click(rowButton('Feature 3'), { ctrlKey: true });
      fireEvent.click(rowButton('Feature 4'), { ctrlKey: true });
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      expect(onDeleteFeatures).toHaveBeenCalledWith(['feature-1', 'feature-3']);
    });

    it('offers the whole batch in the row menu', () => {
      const onDeleteFeatures = vi.fn();
      const { props } = renderTimeline({ onDeleteFeatures });
      fireEvent.click(rowButton('Feature 1'), { ctrlKey: true });
      fireEvent.click(rowButton('Feature 2'), { ctrlKey: true });
      fireEvent.contextMenu(row('Feature 2'));
      const actions = vi.mocked(props.onFeatureContextMenu).mock.calls[0]![2]!;
      expect(actions.deleteSelection?.count).toBe(2);
      actions.deleteSelection!.run();
      expect(onDeleteFeatures).toHaveBeenCalledWith(['feature-1', 'feature-2']);
      fireEvent.contextMenu(row('Feature 3'));
      expect(
        vi.mocked(props.onFeatureContextMenu).mock.calls[1]![2]!.deleteSelection
      ).toBeUndefined();
    });

    it('clears on Escape, a plain click, or a selection made elsewhere', () => {
      const { rerender, props } = renderTimeline({
        onDeleteFeatures: vi.fn()
      });
      const toolbar = () =>
        screen.queryByRole('toolbar', { name: 'Selected steps' });
      fireEvent.click(rowButton('Feature 1'), { ctrlKey: true });
      fireEvent.keyDown(rowButton('Feature 1'), { key: 'Escape' });
      expect(toolbar()).toBeNull();
      fireEvent.click(rowButton('Feature 1'), { ctrlKey: true });
      fireEvent.click(rowButton('Feature 2'));
      expect(toolbar()).toBeNull();
      fireEvent.click(rowButton('Feature 1'), { ctrlKey: true });
      rerender(<HistoryTimeline {...props} selectedFeatureNodeId="node-3" />);
      expect(toolbar()).toBeNull();
    });

    it('batches every visible row with Ctrl/⌘+A', () => {
      renderTimeline({ onDeleteFeatures: vi.fn() });
      fireEvent.keyDown(rowButton('Feature 1'), { key: 'a', ctrlKey: true });
      expect(
        screen.getByRole('toolbar', { name: 'Selected steps' })
      ).toHaveTextContent('4 selected');
    });

    it('drops a deleted step so undo does not bring it back selected', () => {
      const { rerender, props } = renderTimeline({
        onDeleteFeatures: vi.fn()
      });
      fireEvent.click(rowButton('Feature 1'), { ctrlKey: true });
      rerender(
        <HistoryTimeline
          {...props}
          features={[feature(2), feature(3), feature(4)]}
        />
      );
      rerender(<HistoryTimeline {...props} />);
      expect(row('Feature 1')).not.toHaveClass('in-batch');
    });

    it('selects one row at a time without a batch delete', () => {
      const { props } = renderTimeline();
      fireEvent.click(rowButton('Feature 2'), { shiftKey: true });
      expect(props.onSelectFeature).toHaveBeenCalledWith('node-2');
      expect(
        screen.queryByRole('toolbar', { name: 'Selected steps' })
      ).toBeNull();
    });
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
  expect(row('Feature 1').querySelector('.feature-flag.error')).toHaveAttribute(
    'title',
    expect.stringMatching(/re-pick or unlink/)
  );
  // Pending geometry has no verdict yet; nothing is called broken.
  rerender(<HistoryTimeline {...props} geometryPending />);
  expect(screen.queryByText('broken projection')).not.toBeInTheDocument();
});

describe('featureIcon with a forged selector', () => {
  const RESERVED = ['__proto__', 'constructor', 'toString', 'valueOf'];
  const forged = (name: string) => [
    feature(1, { featureKind: 'primitive', primitiveKind: name }),
    feature(2, { featureKind: 'pattern', patternKind: name }),
    feature(3, { featureKind: 'boolean', operation: name }),
    feature(4, { featureKind: 'direct-edit', operation: { kind: name } }),
    { ...feature(5), featureKind: name } as unknown as FeatureNode
  ];

  it.each(RESERVED)('never draws an inherited member for "%s"', (name) => {
    const fallback = forged('unknown-kind').map(featureIcon);
    const icons = forged(name).map(featureIcon);
    expect(icons).toEqual(fallback);
    for (const icon of icons) expect(icon).not.toBe(Object.prototype);
    // The two rows a forged project document reaches with a complete shape.
    const rows = [
      feature(1, {
        featureKind: 'primitive',
        primitiveKind: name,
        dimensions: { width: 1, height: 1, depth: 1 }
      }),
      feature(2, {
        featureKind: 'pattern',
        patternKind: name,
        targetBodyId: 'body-1',
        count: 2,
        axis: 'x',
        spacing: 10
      })
    ];
    expect(() => renderTimeline({ features: rows })).not.toThrow();
    expect(row('Feature 1')).toBeTruthy();
    expect(row('Feature 2')).toBeTruthy();
  });
});
