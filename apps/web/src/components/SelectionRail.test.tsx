import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  within
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  SelectionCalloutContent,
  SelectionCalloutOperation,
  SelectionCalloutVerb
} from '../lib/selectionCallout';
import type { ToolId } from '../lib/tools';
import { refusalIsExpandable } from '../lib/selectionCalloutView';
import { textLabelSegments } from '../lib/topologyLabels';
import {
  selectionRailToolHoldReason,
  selectionRailVerbEnabled
} from '../lib/selectionRailHold';
import {
  SelectionRail,
  SelectionReadout,
  RELEASE_HOLD_MS,
  useHeldPick,
  type HeldPickGuard,
  VALIDATING_ANNOUNCE_MS
} from './SelectionRail';

function operation(
  overrides: Partial<SelectionCalloutOperation> = {}
): SelectionCalloutOperation {
  return {
    title: 'Offset Face',
    phase: 'armed',
    onEditCulprit: vi.fn(),
    onViewDetails: vi.fn(),
    onKeepLastValid: vi.fn(),
    onSelectAllEdges: vi.fn(),
    ...overrides
  };
}

function content(
  overrides: Partial<SelectionCalloutContent> = {}
): SelectionCalloutContent {
  return {
    label: textLabelSegments('Bracket · Top face'),
    detail: '2503.45 mm²',
    verbs: [
      {
        id: 'action:offset-face',
        label: 'Offset',
        title: 'Offset the face',
        disabled: false,
        pressed: true
      },
      {
        id: 'tool:hole',
        label: 'Hole',
        title: 'Hole',
        disabled: false,
        pressed: false
      }
    ],
    anchor: 'selection',
    onVerb: vi.fn(),
    onClear: vi.fn(),
    ...overrides
  };
}

function toolVerb(
  tool: ToolId,
  label: string,
  pressed = false
): SelectionCalloutVerb {
  return { id: `tool:${tool}`, label, title: label, disabled: false, pressed };
}

describe('SelectionRail', () => {
  it('lists every verb of the pick as rail buttons, the armed one lit', () => {
    const onVerb = vi.fn();
    render(<SelectionRail summary="1 face" content={content({ onVerb })} />);
    const rail = screen.getByRole('group', { name: 'Selection' });
    // The name and measurement read in the bar, not on the rail.
    expect(rail).not.toHaveTextContent('Bracket · Top face');
    const offset = within(rail).getByRole('button', {
      name: 'Selection: Offset'
    });
    expect(offset).toHaveAttribute('aria-pressed', 'true');
    expect(offset).toHaveClass('active');
    fireEvent.click(
      within(rail).getByRole('button', { name: 'Selection: Hole' })
    );
    expect(onVerb).toHaveBeenCalledWith('tool:hole');
  });

  it('shows every verb, with no fold to open', () => {
    const verbs = (
      [
        ['transform', 'Move'],
        ['axis-rotate', 'Rotate'],
        ['scale', 'Scale'],
        ['mirror', 'Mirror'],
        ['split', 'Split'],
        ['shell', 'Shell']
      ] as const
    ).map(([tool, label]) => toolVerb(tool, label));
    render(<SelectionRail summary="1 body" content={content({ verbs })} />);
    expect(
      screen
        .getAllByRole('button', { name: /^Selection: / })
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual([
      'Selection: Move',
      'Selection: Rotate',
      'Selection: Scale',
      'Selection: Mirror',
      'Selection: Split',
      'Selection: Shell'
    ]);
    expect(
      screen.queryByRole('button', { name: 'More selection verbs' })
    ).toBeNull();
  });

  it('lets only the verb being made act while its handle is dragged', () => {
    const onClear = vi.fn();
    render(
      <SelectionRail
        summary="1 face"
        content={content({
          onClear,
          operation: operation({ phase: 'dragging', selectAllEdgesCount: 12 })
        })}
      />
    );
    const rail = screen.getByRole('region', { name: 'Offset Face operation' });
    // Every button stays where it was; the others are greyed in place.
    expect(
      within(rail)
        .getAllByRole('button')
        .map((button) => [
          button.getAttribute('aria-label'),
          (button as HTMLButtonElement).disabled
        ])
    ).toEqual([
      ['Deselect all', true],
      ['Selection: Offset', false],
      ['Selection: Hole', true],
      ['Select all 12 edges', true]
    ]);
    expect(rail).toHaveAttribute('data-hold', 'drag');
    fireEvent.click(within(rail).getByRole('button', { name: 'Deselect all' }));
    expect(onClear).not.toHaveBeenCalled();
  });

  it('keeps one set of buttons and one phase slot across a pick lifecycle', () => {
    vi.useFakeTimers();
    try {
      const view = (phase: SelectionCalloutOperation['phase']) => (
        <SelectionRail
          summary="1 face"
          content={content({ operation: operation({ phase }) })}
        />
      );
      const { rerender, container } = render(view('armed'));
      const shape = () => ({
        buttons: Array.from(container.querySelectorAll('button')).map(
          (button) => button.getAttribute('aria-label')
        ),
        slots: container.querySelectorAll('.selection-rail-phase-slot').length
      });
      const armed = shape();
      expect(armed.buttons).toEqual([
        'Deselect all',
        'Selection: Offset',
        'Selection: Hole'
      ]);
      expect(armed.slots).toBe(1);
      for (const phase of ['dragging', 'validating', 'armed'] as const) {
        rerender(view(phase));
        expect(shape()).toEqual(armed);
      }
      // A check that takes time is announced in the same slot.
      rerender(view('dragging'));
      rerender(view('validating'));
      act(() => {
        vi.advanceTimersByTime(VALIDATING_ANNOUNCE_MS);
      });
      expect(shape()).toEqual(armed);
      expect(
        container.querySelector('.selection-rail-phase-slot')
      ).toHaveTextContent('Validating');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the drag look through a quick check after the release', () => {
    const view = (phase: SelectionCalloutOperation['phase']) => (
      <SelectionRail
        summary="1 face"
        content={content({ operation: operation({ phase }) })}
      />
    );
    const { rerender } = render(view('dragging'));
    rerender(view('validating'));
    const rail = screen.getByRole('region', { name: 'Offset Face operation' });
    // Not the quiet hold, which shows every disabled verb at full strength
    // and would undim the others for the check's frame or two.
    expect(rail).toHaveAttribute('data-hold', 'drag');
    expect(rail).not.toHaveAttribute('data-busy');
    rerender(view('armed'));
    expect(rail).not.toHaveAttribute('data-hold');
    for (const button of within(rail).getAllByRole('button')) {
      expect(button).toBeEnabled();
    }
  });

  it('gives an imported face its own edit verb', () => {
    render(
      <SelectionRail
        summary="1 face"
        content={content({
          verbs: [
            {
              id: 'edit-face',
              label: 'Edit face',
              title: 'Resize a hole or remove a fillet on this imported face',
              disabled: false,
              pressed: false
            }
          ]
        })}
      />
    );
    expect(
      screen.getByRole('button', { name: 'Selection: Edit face' })
    ).toBeEnabled();
  });

  it('clears the selection from its head', () => {
    const onClear = vi.fn();
    render(<SelectionRail summary="1 face" content={content({ onClear })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('announces an armed operation and marks only news phases', () => {
    const { rerender } = render(
      <SelectionRail
        summary="1 face"
        content={content({ operation: operation() })}
      />
    );
    const card = screen.getByRole('region', { name: 'Offset Face operation' });
    expect(card.querySelector('.selection-callout-phase')).toBeNull();
    rerender(
      <SelectionRail
        summary="1 face"
        content={content({ operation: operation({ phase: 'failed' }) })}
      />
    );
    expect(card.querySelector('.selection-callout-phase')).toHaveTextContent(
      'Failed'
    );
  });

  it('holds every verb while the exact check validates', () => {
    render(
      <SelectionRail
        summary="1 face"
        content={content({ operation: operation({ phase: 'validating' }) })}
      />
    );
    const card = screen.getByRole('region', { name: 'Offset Face operation' });
    expect(card).toHaveAttribute('aria-busy', 'true');
    for (const button of within(card).getAllByRole('button')) {
      expect(button).toBeDisabled();
    }
  });

  it('holds the verbs at once but announces a check only once it takes time', () => {
    vi.useFakeTimers();
    try {
      const view = (phase: SelectionCalloutOperation['phase']) => (
        <SelectionRail
          summary="1 face"
          content={content({ operation: operation({ phase }) })}
        />
      );
      const { rerender, container } = render(view('dragging'));
      rerender(view('validating'));
      const card = screen.getByRole('region', {
        name: 'Offset Face operation'
      });
      for (const button of within(card).getAllByRole('button')) {
        expect(button).toBeDisabled();
      }
      // Still the drag's dot and the drag's look: most checks answer
      // within a frame or two.
      expect(card).not.toHaveTextContent('Validating');
      expect(
        container.querySelector('.selection-callout-phase-dot')
      ).not.toBeNull();
      expect(card).toHaveAttribute('data-hold', 'drag');
      act(() => {
        vi.advanceTimersByTime(VALIDATING_ANNOUNCE_MS);
      });
      expect(card).toHaveTextContent('Validating');
      expect(card).not.toHaveAttribute('data-busy');
      expect(card).not.toHaveAttribute('data-hold');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never blinks the Validating pill for a quick check', () => {
    vi.useFakeTimers();
    try {
      const view = (phase: SelectionCalloutOperation['phase']) => (
        <SelectionRail
          summary="1 face"
          content={content({ operation: operation({ phase }) })}
        />
      );
      const { rerender } = render(view('exact-entry'));
      rerender(view('validating'));
      const card = screen.getByRole('region', {
        name: 'Offset Face operation'
      });
      // The typed value's pill stays as it was, its verbs not dimmed.
      expect(card).toHaveTextContent('Exact entry');
      expect(card).toHaveAttribute('data-busy', 'quiet');
      act(() => {
        vi.advanceTimersByTime(VALIDATING_ANNOUNCE_MS - 1);
      });
      rerender(view('armed'));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(card).not.toHaveTextContent('Validating');
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers every edge while not all are picked', () => {
    const onSelectAllEdges = vi.fn();
    render(
      <SelectionRail
        summary="1 face"
        content={content({
          operation: operation({
            title: 'Fillet',
            selectAllEdgesCount: 36,
            onSelectAllEdges
          })
        })}
      />
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Select all 36 edges' })
    );
    expect(onSelectAllEdges).toHaveBeenCalledOnce();
  });

  it('never carries the refusal itself', () => {
    render(
      <SelectionRail
        summary="1 face"
        content={content({
          operation: operation({
            phase: 'failed',
            error: { message: 'The face would run into another part.' }
          })
        })}
      />
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('useHeldPick', () => {
  const pickIn = (phase: SelectionCalloutOperation['phase']) =>
    content({ operation: operation({ phase }) });
  type Props = { pick: SelectionCalloutContent | null } & HeldPickGuard;
  const heldRail = (
    pick: SelectionCalloutContent,
    guard: HeldPickGuard = {}
  ) =>
    renderHook<SelectionCalloutContent | null, Props>(
      ({ pick, ...guard }) => useHeldPick(pick, guard),
      {
        initialProps: { pick, ...guard }
      }
    );

  it('holds a pick that drops out on release until it returns', () => {
    vi.useFakeTimers();
    try {
      const dragging = pickIn('dragging');
      const { result, rerender } = heldRail(dragging);
      expect(result.current).toBe(dragging);
      // The release loses the pick for a frame: the rail stays the pick's,
      // every control held as for the check, never the pinned tools.
      rerender({ pick: null });
      expect(result.current?.verbs).toEqual(dragging.verbs);
      expect(result.current?.operation?.phase).toBe('validating');
      act(() => {
        vi.advanceTimersByTime(RELEASE_HOLD_MS - 1);
      });
      expect(result.current).not.toBeNull();
      const armed = pickIn('armed');
      rerender({ pick: armed });
      expect(result.current).toBe(armed);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds through a check too, but gives way once the hold runs out', () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = heldRail(pickIn('validating'));
      rerender({ pick: null });
      expect(result.current?.operation?.phase).toBe('validating');
      act(() => {
        vi.advanceTimersByTime(RELEASE_HOLD_MS);
      });
      expect(result.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives way at once when the document is rewound under the drag', () => {
    vi.useFakeTimers();
    try {
      // Undo while the hand is on the handle: the document steps back and
      // the selection is cleared in one batch. That null is a deselection,
      // not a release settling, so the rail never draws it as a check.
      const { result, rerender } = heldRail(pickIn('dragging'), {
        revision: 'p:0'
      });
      rerender({ pick: null, revision: 'p:1' });
      expect(result.current).toBeNull();
      // Nothing is left to come back after the hold would have run out.
      act(() => {
        vi.advanceTimersByTime(RELEASE_HOLD_MS);
      });
      expect(result.current).toBeNull();
      // A release on the same revision still holds as before.
      rerender({ pick: pickIn('validating'), revision: 'p:1' });
      rerender({ pick: null, revision: 'p:1' });
      expect(result.current?.operation?.phase).toBe('validating');
      // And a rewind during that hold ends it on the spot.
      rerender({ pick: null, revision: 'p:2' });
      expect(result.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives way at once when the held pick’s body is gone', () => {
    const bodies = new Set(['body-1']);
    const isLive = (pick: SelectionCalloutContent) =>
      (pick.bodyIds ?? []).every((id) => bodies.has(id));
    const dragging = content({
      bodyIds: ['body-1'],
      operation: operation({ phase: 'dragging' })
    });
    const { result, rerender } = heldRail(dragging, { isLive });
    // The release settles with the body still there: held.
    rerender({ pick: null, isLive });
    expect(result.current?.operation?.phase).toBe('validating');
    // The body is deleted (or undone away) while held: given way at once,
    // and a body that comes back later does not bring this pick back.
    bodies.delete('body-1');
    rerender({ pick: null, isLive: (pick) => isLive(pick) });
    expect(result.current).toBeNull();
    bodies.add('body-1');
    rerender({ pick: null, isLive: (pick) => isLive(pick) });
    expect(result.current).toBeNull();
  });

  it('never holds a pick that was not held when it left', () => {
    const { result, rerender } = heldRail(pickIn('dragging'));
    // Released and answered, then deselected: the rail gives way at once.
    rerender({ pick: pickIn('armed') });
    rerender({ pick: null });
    expect(result.current).toBeNull();
    // A pick with no operation is never held either.
    rerender({ pick: content() });
    rerender({ pick: null });
    expect(result.current).toBeNull();
  });
});

describe('SelectionReadout', () => {
  it('names the pick and gives its measurement', () => {
    render(
      <SelectionReadout
        label={textLabelSegments('Bracket · Top face')}
        detail="2503.45 mm²"
      />
    );
    const readout = screen.getByRole('group', { name: 'Picked' });
    expect(readout).toHaveTextContent('Bracket · Top face');
    expect(readout).toHaveTextContent('2503.45 mm²');
  });
});

describe('refusalIsExpandable', () => {
  it.each([
    ['a single short sentence', 'The face would run into another part.', false],
    ['two short sentences', 'Radius too large. Try 2 mm.', true],
    [
      'a second sentence that starts with a number',
      'Radius is invalid. 2 edges could not be trimmed.',
      true
    ],
    [
      'a decimal inside one sentence',
      'Fillet refused at radius 1.5 here.',
      false
    ],
    ['exactly 90 characters', 'x'.repeat(90), false],
    ['91 characters', 'x'.repeat(91), true]
  ])('%s', (_case, text, expected) => {
    expect(refusalIsExpandable(text)).toBe(expected);
  });
});

describe('selectionRailToolHoldReason', () => {
  const held = (phase: SelectionCalloutOperation['phase'], verbs = content().verbs) =>
    content({ verbs, operation: operation({ phase }) });

  it('agrees with the rail’s buttons on every tool verb', () => {
    for (const phase of [
      'armed',
      'dragging',
      'validating',
      'failed',
      'exact-entry'
    ] as const) {
      const pick = held(phase, [
        toolVerb('hole', 'Hole'),
        toolVerb('shell', 'Shell', true)
      ]);
      const { unmount } = render(
        <SelectionRail summary="1 face" content={pick} />
      );
      for (const verb of pick.verbs) {
        const tool = verb.id.slice('tool:'.length) as ToolId;
        const button = screen.getByRole('button', {
          name: `Selection: ${verb.label}`
        });
        // While held, a shortcut launches exactly what the rail leaves
        // enabled; otherwise the rail does not stand in a launch's way.
        if (phase === 'dragging' || phase === 'validating') {
          expect(selectionRailToolHoldReason(pick, tool) === null).toBe(
            !(button as HTMLButtonElement).disabled
          );
        } else {
          expect(selectionRailToolHoldReason(pick, tool)).toBeNull();
        }
        expect(selectionRailVerbEnabled(pick, verb)).toBe(
          !(button as HTMLButtonElement).disabled
        );
      }
      unmount();
    }
  });

  it('refuses a shortcut for a tool the held rail greys out', () => {
    // Hole is on the rail, disabled, while Offset is dragged; a tool the
    // rail does not carry at all is refused as well.
    expect(selectionRailToolHoldReason(held('dragging'), 'hole')).toMatch(
      /Offset Face is being dragged.*Esc/
    );
    expect(selectionRailToolHoldReason(held('dragging'), 'shell')).toMatch(
      /being dragged/
    );
    expect(selectionRailToolHoldReason(held('validating'), 'hole')).toMatch(
      /Offset Face is being checked · Hole/
    );
    // Not held, nothing picked: no refusal.
    expect(selectionRailToolHoldReason(held('armed'), 'hole')).toBeNull();
    expect(selectionRailToolHoldReason(null, 'hole')).toBeNull();
  });
});
