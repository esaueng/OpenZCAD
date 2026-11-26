import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FeatureId, FeatureNode } from '@openzcad/shared';
import type { HistoryRowActions } from '../HistoryTimeline';
import {
  CompactHistoryList,
  type CompactHistoryListProps
} from './CompactHistoryList';
import { SWIPE_ACTION_PX } from './rowGestures';

function feature(
  index: number,
  metadata: Record<string, unknown> = {}
): FeatureNode {
  return {
    id: `node-${index}`,
    kind: 'feature',
    name: `Step number ${index} with a long name`,
    featureId: `feature-${index}` as FeatureId,
    featureKind: 'extrude',
    data: { featureKind: 'extrude' },
    metadata
  } as unknown as FeatureNode;
}

function list(overrides: Partial<CompactHistoryListProps> = {}) {
  const props = {
    features: [feature(1), feature(2), feature(3)],
    representations: {},
    selectedFeatureNodeId: null,
    parameterValues: {},
    units: 'mm' as const,
    onFeatureContextMenu:
      vi.fn<
        (
          at: { clientX: number; clientY: number },
          feature: FeatureNode,
          row?: HistoryRowActions
        ) => void
      >(),
    onToggleFeatureSuppression: vi.fn(),
    onRollbackAfterFeature: vi.fn(),
    onResumeHistory: vi.fn(),
    onReorderFeature: vi.fn(),
    onRenameFeature: vi.fn(),
    onDeleteFeatures: vi.fn(),
    onEditStep: vi.fn()
  };
  const view = render(<CompactHistoryList {...props} {...overrides} />);
  return { ...view, props };
}

const row = (container: HTMLElement, index: number) =>
  container.querySelectorAll<HTMLElement>('.compact-row')[index]!;

/** Drags a finger across the row's face by `dx`. */
function swipe(face: Element, dx: number) {
  fireEvent.pointerDown(face, {
    pointerId: 1,
    button: 0,
    clientX: 200,
    clientY: 20
  });
  fireEvent.pointerMove(face, {
    pointerId: 1,
    clientX: 200 + dx / 2,
    clientY: 21
  });
  fireEvent.pointerMove(face, { pointerId: 1, clientX: 200 + dx, clientY: 21 });
  fireEvent.pointerUp(face, { pointerId: 1, clientX: 200 + dx, clientY: 21 });
}

describe('CompactHistoryList', () => {
  it('draws a full-width row per step with its name whole', () => {
    const { container } = list();
    const rows = container.querySelectorAll('.compact-row');
    expect(rows).toHaveLength(3);
    // The whole name, wrapped by CSS rather than cut short in the markup.
    expect(
      within(rows[0] as HTMLElement).getByText('Step number 1 with a long name')
    ).toHaveClass('compact-row-name');
  });

  it('opens a step’s edit on a tap', () => {
    const { container, props } = list();
    fireEvent.click(row(container, 1).querySelector('.compact-row-main')!);
    expect(props.onEditStep).toHaveBeenCalledWith(props.features[1]);
  });

  it('uncovers Suppress and Delete on a swipe left, without opening the step', () => {
    const { container, props } = list();
    const target = row(container, 1);
    const face = target.querySelector('.compact-row-face')!;
    swipe(face, -2 * SWIPE_ACTION_PX);
    expect(face).toHaveStyle({
      transform: `translateX(${-2 * SWIPE_ACTION_PX}px)`
    });
    // The click the lift makes is not a tap on the step.
    fireEvent.click(target.querySelector('.compact-row-main')!);
    expect(props.onEditStep).not.toHaveBeenCalled();
    fireEvent.click(
      within(target).getByRole('button', {
        name: 'Suppress Step number 2 with a long name'
      })
    );
    expect(props.onToggleFeatureSuppression).toHaveBeenCalledWith(
      props.features[1]
    );
    swipe(target.querySelector('.compact-row-face')!, -2 * SWIPE_ACTION_PX);
    fireEvent.click(
      within(target).getByRole('button', {
        name: 'Delete Step number 2 with a long name'
      })
    );
    expect(props.onDeleteFeatures).toHaveBeenCalledWith(['feature-2']);
  });

  it('rolls back on a swipe right, and offers no roll back on the last step', () => {
    const { container, props } = list();
    swipe(row(container, 0).querySelector('.compact-row-face')!, 120);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Roll back to Step number 1 with a long name'
      })
    );
    expect(props.onRollbackAfterFeature).toHaveBeenCalledWith(
      'feature-1',
      'Step number 1 with a long name'
    );
    expect(
      within(row(container, 2)).queryByRole('button', { name: /^Roll back/ })
    ).toBeNull();
  });

  it('snaps a short swipe closed', () => {
    const { container } = list();
    const face = row(container, 0).querySelector('.compact-row-face')!;
    swipe(face, -20);
    expect(face).not.toHaveAttribute('style');
  });

  it('opens the row’s whole menu from More and a long press, with its actions', () => {
    const { container, props } = list();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'More actions for Step number 2 with a long name'
      })
    );
    expect(props.onFeatureContextMenu).toHaveBeenCalledTimes(1);
    const [, feature, actions] = props.onFeatureContextMenu.mock.calls[0]!;
    if (!actions) throw new Error('the row’s actions');
    expect(feature).toBe(props.features[1]);
    expect(actions.endOfHistory).toBeNull();
    actions.rollBack();
    expect(props.onRollbackAfterFeature).toHaveBeenCalledWith(
      'feature-2',
      'Step number 2 with a long name'
    );
    // A long press reaches the row as a context menu.
    fireEvent.contextMenu(
      row(container, 2).querySelector('.compact-row-main')!
    );
    expect(props.onFeatureContextMenu.mock.calls[1]![2]?.endOfHistory).toBe(
      'last'
    );
  });

  it('renames in place from the menu’s Rename', () => {
    const { container, props } = list();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'More actions for Step number 1 with a long name'
      })
    );
    const actions = props.onFeatureContextMenu.mock.calls[0]![2];
    act(() => {
      actions?.rename?.();
    });
    const field = screen.getByRole('textbox', {
      name: 'Rename Step number 1 with a long name'
    });
    fireEvent.change(field, { target: { value: 'Base plate' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(props.onRenameFeature).toHaveBeenCalledWith(
      'feature-1',
      'Base plate'
    );
    expect(container.querySelector('.compact-row-rename')).toBeNull();
  });

  it('reorders by the grip’s arrow keys, within the list', () => {
    const { props } = list();
    const grip = screen.getByRole('button', {
      name: 'Reorder Step number 2 with a long name. Use the arrow keys to move it.'
    });
    fireEvent.keyDown(grip, { key: 'ArrowUp' });
    expect(props.onReorderFeature).toHaveBeenCalledWith('feature-2', 0);
    fireEvent.keyDown(
      screen.getByRole('button', {
        name: 'Reorder Step number 3 with a long name. Use the arrow keys to move it.'
      }),
      { key: 'ArrowDown' }
    );
    expect(props.onReorderFeature).toHaveBeenCalledTimes(1);
  });

  it('holds the grip still while a rebuild runs', () => {
    const { props } = list({ reorderBusy: true });
    const grip = screen.getByRole('button', {
      name: 'Reorder Step number 2 with a long name. Use the arrow keys to move it.'
    });
    expect(grip).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(grip, { key: 'ArrowUp' });
    expect(props.onReorderFeature).not.toHaveBeenCalled();
  });

  it('marks suppressed and rolled-back steps and offers Resume full history', () => {
    const { container, props } = list({
      features: [
        feature(1),
        feature(2, { suppressed: true }),
        feature(3, { rollbackSuppressed: true })
      ]
    });
    expect(row(container, 1)).toHaveClass('is-suppressed');
    expect(row(container, 2)).toHaveClass('is-paused');
    // Its swipe action reads Resume; put away, it is hidden from the
    // accessibility tree, and the row's menu offers it instead.
    expect(
      within(row(container, 1)).getByRole('button', {
        name: 'Resume Step number 2 with a long name',
        hidden: true
      })
    ).toHaveAttribute('tabindex', '-1');
    fireEvent.click(
      screen.getByRole('button', { name: 'Resume full history' })
    );
    expect(props.onResumeHistory).toHaveBeenCalledTimes(1);
  });

  it('keeps History as text in reach', () => {
    const toggle = vi.fn();
    list({ historyText: { open: false, toggle } });
    fireEvent.click(screen.getByRole('button', { name: 'History as text' }));
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});
