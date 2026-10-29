import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  SelectionCalloutContent,
  SelectionCalloutOperation,
  SelectionCalloutVerb
} from '../lib/selectionCallout';
import type { ToolId } from '../lib/tools';
import { textLabelSegments } from '../lib/topologyLabels';
import {
  SelectionRail,
  SelectionReadout,
  SelectionRefusal,
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

  it('keeps only the verb being made while its handle is dragged', () => {
    render(
      <SelectionRail
        summary="1 face"
        content={content({ operation: operation({ phase: 'dragging' }) })}
      />
    );
    const rail = screen.getByRole('region', { name: 'Offset Face operation' });
    expect(
      within(rail)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Selection: Offset']);
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
      // Still the drag's dot, held but not dimmed: most checks answer
      // within a frame or two.
      expect(card).not.toHaveTextContent('Validating');
      expect(
        container.querySelector('.selection-callout-phase-dot')
      ).not.toBeNull();
      expect(card).toHaveAttribute('data-busy', 'quiet');
      act(() => {
        vi.advanceTimersByTime(VALIDATING_ANNOUNCE_MS);
      });
      expect(card).toHaveTextContent('Validating');
      expect(card).not.toHaveAttribute('data-busy');
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
      // The typed value's pill stays as it was.
      expect(card).toHaveTextContent('Exact entry');
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

describe('SelectionRefusal', () => {
  it('says why it refused, with each way out as a button', () => {
    const onEditCulprit = vi.fn();
    const onKeepLastValid = vi.fn();
    const onViewDetails = vi.fn();
    render(
      <SelectionRefusal
        operation={operation({
          phase: 'failed',
          error: {
            message: 'The face would run into another part.',
            detail: 'kernel words',
            culprit: { featureId: 'feature-7', featureName: 'Boss' }
          },
          keepLastValidLabel: 'Keep 4 mm',
          onEditCulprit,
          onKeepLastValid,
          onViewDetails
        })}
      />
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The face would run into another part.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Edit Boss' }));
    fireEvent.click(within(alert).getByRole('button', { name: 'Keep 4 mm' }));
    fireEvent.click(
      within(alert).getByRole('button', { name: 'View details' })
    );
    expect(onEditCulprit).toHaveBeenCalledWith('feature-7');
    expect(onKeepLastValid).toHaveBeenCalledOnce();
    expect(onViewDetails).toHaveBeenCalledOnce();
  });

  it('draws nothing while the operation stands', () => {
    const { container } = render(<SelectionRefusal operation={operation()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
