import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  SelectionCalloutContent,
  SelectionCalloutOperation
} from '../lib/selectionCallout';
import { textLabelSegments } from '../lib/topologyLabels';
import {
  SelectionCard,
  SelectionRefusal,
  VALIDATING_ANNOUNCE_MS
} from './SelectionCard';

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

describe('SelectionCard', () => {
  it('names the pick, gives its measurement and lists its verbs', () => {
    const onVerb = vi.fn();
    render(<SelectionCard content={content({ onVerb })} />);
    const card = screen.getByRole('group', { name: 'Selection' });
    expect(card).toHaveTextContent('Bracket · Top face');
    expect(card).toHaveTextContent('2503.45 mm²');
    expect(
      within(card).getByRole('button', { name: 'Selection: Offset' })
    ).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(
      within(card).getByRole('button', { name: 'Selection: Hole' })
    );
    expect(onVerb).toHaveBeenCalledWith('tool:hole');
  });

  it('clears the selection from its header', () => {
    const onClear = vi.fn();
    render(<SelectionCard content={content({ onClear })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('announces an armed operation and marks only news phases', () => {
    const { rerender } = render(
      <SelectionCard content={content({ operation: operation() })} />
    );
    const card = screen.getByRole('region', { name: 'Offset Face operation' });
    expect(card.querySelector('.selection-callout-phase')).toBeNull();
    rerender(
      <SelectionCard
        content={content({ operation: operation({ phase: 'failed' }) })}
      />
    );
    expect(card.querySelector('.selection-callout-phase')).toHaveTextContent(
      'Failed'
    );
  });

  it('holds every verb while the exact check validates', () => {
    render(
      <SelectionCard
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
        <SelectionCard content={content({ operation: operation({ phase }) })} />
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
        <SelectionCard content={content({ operation: operation({ phase }) })} />
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
      <SelectionCard
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
      <SelectionCard
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
