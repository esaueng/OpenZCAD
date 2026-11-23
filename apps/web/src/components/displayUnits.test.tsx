import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnitSystem } from '@openzcad/shared';
import { ExprInput } from './ExprInput';
import { NumericKeypad, type KeypadRequest } from './NumericKeypad';
import { DisplayUnitsRow } from './TopBar';
import { roundShownLength, setLiveDiameter } from '../lib/liveLabels';
import {
  DisplayUnitsProvider,
  fieldNumberText,
  shownLengthText,
  storedLengthText
} from '../lib/displayUnits';

/**
 * I03 display units in the workspace: a millimetre project shown in inches
 * shows and takes lengths in inches, while every value handed back to the
 * document stays in millimetres.
 */

const LENGTH_MM = { documentUnits: 'mm', dimension: 'length' } as const;

function LengthField({
  initial,
  onStored
}: {
  initial: string;
  onStored(value: string): void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ExprInput
      label="Distance"
      value={value}
      scope={{ width: 50.8 }}
      quantity={LENGTH_MM}
      onChange={(next) => {
        setValue(next);
        onStored(next);
      }}
    />
  );
}

describe('length text across display units', () => {
  it('shows a stored plain number in the display unit, expressions as written', () => {
    expect(shownLengthText('25.4', 'mm', 'inch')).toBe('1');
    expect(shownLengthText('1.5875', 'mm', 'inch')).toBe('0.0625');
    expect(shownLengthText('width / 2', 'mm', 'inch')).toBe('width / 2');
    expect(shownLengthText('1 in', 'mm', 'cm')).toBe('1 in');
    expect(shownLengthText('20', 'mm', 'mm')).toBe('20');
  });

  it('stores a typed plain number as the same length in the stored unit', () => {
    expect(storedLengthText('1', 'mm', 'inch')).toBe('25.4');
    expect(storedLengthText('2', 'inch', 'cm')).toBe(String(20 / 25.4));
    expect(storedLengthText('width + 1 in', 'mm', 'inch')).toBe('width + 1 in');
    expect(storedLengthText('3', 'cm', 'cm')).toBe('3');
  });

  it('writes converted numbers without float noise', () => {
    expect(fieldNumberText(0.1 + 0.2)).toBe('0.3');
    expect(fieldNumberText(20 / 25.4)).toBe('0.787401574803');
  });
});

describe('a length field in a project shown in other units', () => {
  it('reads and takes inches while storing millimetres', () => {
    const onStored = vi.fn();
    render(
      <DisplayUnitsProvider units="inch">
        <LengthField initial="50.8" onStored={onStored} />
      </DisplayUnitsProvider>
    );
    const input = screen.getByRole<HTMLInputElement>('textbox', {
      name: 'Distance (in)'
    });
    expect(input.value).toBe('2');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '1.5' } });
    // The typed text stays under the caret; the document gets millimetres.
    expect(input.value).toBe('1.5');
    expect(onStored).toHaveBeenLastCalledWith(String(1.5 * 25.4));
    fireEvent.blur(input);
    expect(input.value).toBe('1.5');
  });

  it('keeps an expression as typed and previews it in the display unit', () => {
    const onStored = vi.fn();
    render(
      <DisplayUnitsProvider units="inch">
        <LengthField initial="width / 2" onStored={onStored} />
      </DisplayUnitsProvider>
    );
    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Distance (in)' })
        .value
    ).toBe('width / 2');
    // width is a stored 50.8 mm: half of it is 1 in.
    expect(screen.getByText('= 1 in')).toHaveClass('expr-preview');
  });

  it('is unchanged without a display unit, or in the stored unit', () => {
    for (const units of [null, 'mm'] as const) {
      const { unmount } = render(
        <DisplayUnitsProvider units={units}>
          <LengthField initial="50.8" onStored={vi.fn()} />
        </DisplayUnitsProvider>
      );
      expect(
        screen.getByRole<HTMLInputElement>('textbox', { name: 'Distance' })
          .value
      ).toBe('50.8');
      unmount();
    }
  });

  it('leaves an angle field alone', () => {
    render(
      <DisplayUnitsProvider units="inch">
        <ExprInput
          label="Angle"
          value="30"
          scope={{}}
          quantity={{ documentUnits: 'mm', dimension: 'angle' }}
          onChange={vi.fn()}
        />
      </DisplayUnitsProvider>
    );
    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Angle' }).value
    ).toBe('30');
  });
});

describe('the keypad in a project shown in other units', () => {
  // A touch screen opens the pad with its unit chips showing.
  beforeEach(() => {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false
    });
  });

  function renderKeypad(
    initial: string,
    shown: UnitSystem = 'inch',
    extra: Partial<KeypadRequest> = {}
  ) {
    const onCommit = vi.fn();
    const request: KeypadRequest = {
      kind: 'offset',
      label: 'Height',
      initial,
      unitKind: 'length',
      ...extra
    };
    render(
      <DisplayUnitsProvider units={shown}>
        <NumericKeypad
          request={request}
          units="mm"
          scope={{}}
          anchorRef={{ current: null }}
          onPreview={vi.fn()}
          onCommit={onCommit}
          onCancel={() => undefined}
        />
      </DisplayUnitsProvider>
    );
    return {
      input: screen.getByRole<HTMLInputElement>('textbox', { name: 'Height' }),
      onCommit
    };
  }

  it('opens on the display unit with the prefill converted', () => {
    const { input } = renderKeypad('20');
    expect(input.value).toBe('0.787401574803');
    expect(screen.getByRole('radio', { name: 'in' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('commits an untouched prefill as the exact stored value', () => {
    const { input, onCommit } = renderKeypad('20');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(20, '20');
  });

  it('reads a typed number in the display unit and commits millimetres', () => {
    const { input, onCommit } = renderKeypad('20');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(25.4, '25.4');
  });

  it('reads captured keys as typed, and a proved stored size as stored', () => {
    // A key captured to open the pad was typed in the display unit.
    const typed = renderKeypad('2', 'inch', { selectInitial: false });
    fireEvent.keyDown(typed.input, { key: 'Enter' });
    expect(typed.onCommit).toHaveBeenCalledWith(50.8, '50.8');
    cleanup();
    // "Try 2.5 mm" seeds a document-unit size unselected (review #1915).
    const proved = renderKeypad('2.5', 'inch', {
      selectInitial: false,
      initialIsStored: true
    });
    expect(proved.input.value).toBe(
      String(Number((2.5 / 25.4).toPrecision(12)))
    );
    fireEvent.keyDown(proved.input, { key: 'Enter' });
    expect(proved.onCommit).toHaveBeenCalledWith(2.5, '2.5');
  });

  it('opens an expression prefill on the stored unit, where it means the same', () => {
    renderKeypad('5 + 5');
    expect(screen.getByRole('radio', { name: 'mm' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});

describe('the File menu Units row', () => {
  it('switches the display unit and says the model keeps its size', () => {
    const onChange = vi.fn();
    render(<DisplayUnitsRow shown="inch" stored="mm" onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: 'Units' });
    expect(group).toHaveAccessibleDescription(
      'Shown and typed in in. The model is stored in mm and keeps its exact size.'
    );
    expect(screen.getByRole('radio', { name: 'Inches (in)' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Inches (in)' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Millimeters (mm)' }));
    expect(onChange).toHaveBeenCalledWith('mm');
  });

  it('is one Tab stop, moved and chosen with the arrow keys', () => {
    const onChange = vi.fn();
    render(<DisplayUnitsRow shown="inch" stored="mm" onChange={onChange} />);
    const inch = screen.getByRole('radio', { name: 'Inches (in)' });
    expect(inch).toHaveAttribute('tabindex', '0');
    expect(
      screen.getByRole('radio', { name: 'Millimeters (mm)' })
    ).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(inch, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('mm');
    fireEvent.keyDown(inch, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('m');
  });

  it('names a stored unit once, as the display unit', () => {
    render(
      <DisplayUnitsProvider units="inch">
        <ExprInput
          label="Radius (mm)"
          value="25.4"
          scope={{}}
          quantity={LENGTH_MM}
          onChange={vi.fn()}
        />
      </DisplayUnitsProvider>
    );
    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Radius (in)' })
        .value
    ).toBe('1');
  });

  it('is read-only with the reason it cannot change', () => {
    render(
      <DisplayUnitsRow
        shown="mm"
        stored="mm"
        onChange={vi.fn()}
        disabledReason="Only the project owner can rename outside Build mode"
      />
    );
    for (const radio of screen.getAllByRole('radio'))
      expect(radio).toBeDisabled();
  });

  it('offers converting the stored unit below the display choice, disabled with a reason', () => {
    const onConvertStored = vi.fn();
    const { rerender } = render(
      <DisplayUnitsRow
        shown="mm"
        stored="mm"
        onChange={vi.fn()}
        onConvertStored={onConvertStored}
      />
    );
    const item = screen.getByRole('button', {
      name: /^Convert stored units…/
    });
    expect(item).toHaveTextContent('rare · rewrites the model’s numbers');
    fireEvent.click(item);
    expect(onConvertStored).toHaveBeenCalledTimes(1);
    rerender(
      <DisplayUnitsRow
        shown="mm"
        stored="mm"
        onChange={vi.fn()}
        onConvertStored={onConvertStored}
        convertDisabledReason="This shared project is read-only"
      />
    );
    expect(
      screen.getByRole('button', { name: /^Convert stored units…/ })
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /^Convert stored units…/ })
    ).toHaveTextContent('This shared project is read-only');
  });
});

describe('read-outs converted into a display unit', () => {
  it('keep small values instead of rounding them to zero', () => {
    expect(roundShownLength(0.002)).toBe(0.002);
    expect(roundShownLength(0.0123456)).toBe(0.0123);
    expect(roundShownLength(12.3456)).toBe(12.35);
    expect(roundShownLength(0)).toBe(0);
  });

  it('rewrite a scaled live diameter in the shown unit', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<span data-live-diameter-detail="2" data-units="m" data-unit-scale="0.001"></span>';
    setLiveDiameter(root, 6);
    expect(root.textContent).toBe('Ø 0.006 m');
    setLiveDiameter(root, null);
    expect(root.textContent).toBe('Ø 0.002 m');
  });
});
