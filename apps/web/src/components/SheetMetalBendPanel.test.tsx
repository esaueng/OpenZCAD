import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SketchId } from '@openzcad/shared';
import { SheetMetalBendPanel } from './SheetMetalBendPanel';
import type { BendRow } from '../lib/inPlace/sheetMetal';

const LINE = { sketchId: 'sketch_1' as SketchId, entityId: 'ent_a' };

const ROW: BendRow = {
  id: 'b1',
  line: LINE,
  angle: 'a + 5',
  direction: 'up',
  position: 'centerline',
  radius: 2,
  saved: true
};

function panel(
  overrides: Partial<Parameters<typeof SheetMetalBendPanel>[0]> = {}
) {
  const props = {
    rows: [ROW],
    unitLabel: 'mm',
    evaluate: (text: string) =>
      Number.isFinite(Number(text))
        ? Number(text)
        : text === 'a + 5'
          ? 95
          : null,
    onOption: vi.fn(),
    onRefuse: vi.fn(),
    onRestore: vi.fn(),
    onRemove: vi.fn(),
    fold: 0,
    onFold: vi.fn(),
    fixedPoint: undefined,
    onClearFixed: vi.fn(),
    ...overrides
  };
  render(<SheetMetalBendPanel {...props} />);
  return props;
}

describe('SheetMetalBendPanel', () => {
  it('shows each row as stored, an expression as typed', () => {
    panel();
    expect(
      screen.getByRole('region', { name: 'Bend table' })
    ).toHaveTextContent('1 bend');
    expect(screen.getByLabelText('Bend 1 angle')).toHaveValue('a + 5');
    expect(screen.getByLabelText('Bend 1 inside radius (mm)')).toHaveValue('2');
    expect(screen.getByLabelText('Bend 1 K-factor')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Up' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByLabelText('Bend 1 position')).toHaveValue('centerline');
    expect(screen.getByText(/largest region stays fixed/)).toBeInTheDocument();
  });

  it('sets each field as a row option, and refuses what does not evaluate', async () => {
    const user = userEvent.setup();
    const props = panel();
    const angle = screen.getByLabelText('Bend 1 angle');
    await user.clear(angle);
    await user.type(angle, 'nope{Enter}');
    expect(angle).toHaveAttribute('aria-invalid', 'true');
    expect(props.onOption).not.toHaveBeenCalled();
    // Refused through the command, so Done waits (review finding 3).
    expect(props.onRefuse).toHaveBeenCalledWith(
      'bend.ent_a.angle',
      'Bend 1 angle: nope is not a number or a known expression.'
    );
    await user.keyboard('{Escape}');
    expect(props.onRestore).toHaveBeenCalledWith('bend.ent_a.angle');
    expect(angle).toHaveValue('a + 5');
    await user.clear(angle);
    await user.type(angle, 'nope{Enter}');
    await user.clear(angle);
    await user.type(angle, '45{Enter}');
    expect(props.onOption).toHaveBeenLastCalledWith('bend.ent_a.angle', '45');
    expect(props.onRestore).toHaveBeenLastCalledWith('bend.ent_a.angle');
    await user.click(screen.getByRole('button', { name: 'Down' }));
    expect(props.onOption).toHaveBeenLastCalledWith(
      'bend.ent_a.direction',
      'down'
    );
    // An override emptied goes back to the sheet's own.
    const radius = screen.getByLabelText('Bend 1 inside radius (mm)');
    await user.clear(radius);
    await user.tab();
    expect(props.onOption).toHaveBeenLastCalledWith('bend.ent_a.radius', '');
    await user.selectOptions(
      screen.getByLabelText('Bend 1 position'),
      'outside-mold-line'
    );
    expect(props.onOption).toHaveBeenLastCalledWith(
      'bend.ent_a.position',
      'outside-mold-line'
    );
    await user.click(screen.getByRole('button', { name: 'Remove Bend 1' }));
    expect(props.onRemove).toHaveBeenCalledWith(LINE);
  });

  it('moves the fold and puts the fixed region back', async () => {
    const user = userEvent.setup();
    const props = panel({ fixedPoint: [3, 4], rows: [] });
    expect(
      screen.getByRole('region', { name: 'Bend table' })
    ).toHaveTextContent('No bends');
    expect(
      screen.getByText(/Fixed where clicked \(3, 4\)/)
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Largest' }));
    expect(props.onClearFixed).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Fold preview'), {
      target: { value: '40' }
    });
    expect(props.onFold).toHaveBeenCalledWith(40);
  });
});

describe('SheetMetalBendPanel: a row whose line is gone', () => {
  it('stays, says so, and is removed on purpose', async () => {
    const user = userEvent.setup();
    const props = panel({ missingLines: new Set(['ent_a']) });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Bend 1: its line is gone from the sketch'
    );
    await user.click(screen.getByRole('button', { name: 'Remove Bend 1' }));
    expect(props.onRemove).toHaveBeenCalledWith(LINE);
  });
});

describe('SheetMetalBendPanel: a refused field that is hidden', () => {
  it('gives its refusal up, so Done is not held by a value nobody sees (re-check)', async () => {
    const user = userEvent.setup();
    const withRelief = (shape: 'rectangular' | 'none'): BendRow => ({
      ...ROW,
      relief: { shape, width: 3 }
    });
    const props = {
      unitLabel: 'mm',
      evaluate: (text: string) =>
        Number.isFinite(Number(text)) ? Number(text) : null,
      onOption: vi.fn(),
      onRefuse: vi.fn(),
      onRestore: vi.fn(),
      onRemove: vi.fn(),
      fold: 0,
      onFold: vi.fn(),
      fixedPoint: undefined,
      onClearFixed: vi.fn()
    };
    const { rerender } = render(
      <SheetMetalBendPanel {...props} rows={[withRelief('rectangular')]} />
    );
    const width = screen.getByLabelText('Bend 1 relief width (mm)');
    await user.clear(width);
    await user.type(width, 'nope{Enter}');
    expect(props.onRefuse).toHaveBeenCalledWith(
      'bend.ent_a.reliefWidth',
      expect.stringContaining('nope')
    );
    expect(props.onRestore).not.toHaveBeenCalled();
    // No relief hides the width field with its refused draft.
    rerender(<SheetMetalBendPanel {...props} rows={[withRelief('none')]} />);
    expect(
      screen.queryByLabelText('Bend 1 relief width (mm)')
    ).not.toBeInTheDocument();
    expect(props.onRestore).toHaveBeenCalledWith('bend.ent_a.reliefWidth');
    // Shown again, a valid entry and Escape both release, unconditionally.
    rerender(
      <SheetMetalBendPanel {...props} rows={[withRelief('rectangular')]} />
    );
    props.onRestore.mockClear();
    const shown = screen.getByLabelText('Bend 1 relief width (mm)');
    await user.clear(shown);
    await user.type(shown, '4{Enter}');
    expect(props.onOption).toHaveBeenLastCalledWith(
      'bend.ent_a.reliefWidth',
      '4'
    );
    expect(props.onRestore).toHaveBeenCalledWith('bend.ent_a.reliefWidth');
    props.onRestore.mockClear();
    shown.focus();
    await user.keyboard('{Escape}');
    expect(props.onRestore).toHaveBeenCalledWith('bend.ent_a.reliefWidth');
  });
});
