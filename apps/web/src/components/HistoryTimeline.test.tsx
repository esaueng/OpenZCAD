import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  FEATURE_SUPPRESSED_METADATA_KEY
} from '@openzcad/shared';
import type { FeatureId, FeatureNode } from '@openzcad/shared';
import { HistoryTimeline } from './HistoryTimeline';

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

function renderTimeline(
  overrides: Partial<ComponentProps<typeof HistoryTimeline>> = {}
) {
  const props: ComponentProps<typeof HistoryTimeline> = {
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
  return { ...render(<HistoryTimeline {...props} />), props };
}

function row(name: string): HTMLElement {
  return screen.getByText(name).closest('.feature-row') as HTMLElement;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HistoryTimeline', () => {
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
