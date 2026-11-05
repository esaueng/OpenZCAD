import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutEffect } from 'react';
import {
  NumericKeypad,
  operationTagLabel,
  resetKeypadPointerForTests,
  type KeypadRequest
} from './NumericKeypad';
import type { PreviewVerdict } from '../lib/keypad';
import type { CommandDiagnostic } from '../lib/interaction/machine';
import type { SelectionCalloutOperation } from '../lib/selectionCallout';
import { prepareCommandChip } from '../lib/inPlace/chipNames';

/** Answers `(pointer: fine)` as a mouse (true) or a touch screen (false). */
function stubPointer(fine: boolean) {
  window.matchMedia = (query: string) => ({
    matches: query === '(pointer: fine)' ? fine : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  });
}

// Most of this file exercises the keys and unit chips, which a touch screen
// opens with; the fine-pointer fold has its own suite below.
beforeEach(() => stubPointer(false));

function setup(initial: string, selectInitial?: boolean) {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  const request: KeypadRequest = {
    kind: 'offset',
    label: 'Height',
    initial,
    unitKind: 'length',
    selectInitial
  };
  render(
    <NumericKeypad
      request={request}
      units="mm"
      scope={{}}
      anchorRef={{ current: null }}
      onPreview={onPreview}
      onCommit={onCommit}
      onCancel={() => undefined}
    />
  );
  return {
    input: screen.getByRole<HTMLInputElement>('textbox', { name: 'Height' }),
    onPreview,
    onCommit
  };
}

describe('numeric entry first character', () => {
  it('treats a captured first key as a new Total, rather than the rounded prefill', () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(
      <NumericKeypad
        request={{
          kind: 'offset',
          label: 'Total',
          initial: '4',
          selectInitial: false,
          totalBaseline: 35.00168,
          initialOffset: 0,
          unitKind: 'length'
        }}
        units="mm"
        scope={{}}
        anchorRef={{ current: null }}
        onPreview={onPreview}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
    expect(onPreview.mock.calls[0]?.[0]).toBeCloseTo(4 - 35.00168, 8);
    fireEvent.click(screen.getByRole('button', { name: 'Apply total' }));
    expect(onCommit.mock.calls[0]?.[0]).toBeCloseTo(4 - 35.00168, 8);
    expect(onCancel).not.toHaveBeenCalled();
  });
  it.each([0, 2])(
    'preserves an untouched Total prefill at offset %s without rounding the model',
    (initialOffset) => {
      const onCommit = vi.fn();
      const onCancel = vi.fn();
      render(
        <NumericKeypad
          request={{
            kind: 'offset',
            label: 'Total',
            initial: String(35 + initialOffset),
            totalBaseline: 35.00168,
            initialOffset,
            unitKind: 'length'
          }}
          units="mm"
          scope={{}}
          anchorRef={{ current: null }}
          onPreview={vi.fn()}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Apply total' }));
      if (initialOffset === 0) {
        expect(onCancel).toHaveBeenCalledOnce();
        expect(onCommit).not.toHaveBeenCalled();
      } else {
        expect(onCommit).toHaveBeenCalledWith(
          initialOffset,
          String(initialOffset)
        );
        expect(onCancel).not.toHaveBeenCalled();
      }
    }
  );
  it.each(['typing', 'units'] as const)(
    'evaluates an explicitly edited Total after a %s round trip',
    (method) => {
      const onCommit = vi.fn();
      const onCancel = vi.fn();
      render(
        <NumericKeypad
          request={{
            kind: 'offset',
            label: 'Total',
            initial: '35.00',
            unitKind: 'length',
            totalBaseline: 35.00168,
            initialOffset: 0
          }}
          units="mm"
          scope={{}}
          anchorRef={{ current: null }}
          onPreview={vi.fn()}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      );
      if (method === 'typing') {
        fireEvent.change(screen.getByRole('textbox'), {
          target: { value: '35.1' }
        });
        fireEvent.change(screen.getByRole('textbox'), {
          target: { value: '35.00' }
        });
      } else {
        fireEvent.click(screen.getByRole('radio', { name: 'cm' }));
        fireEvent.click(screen.getByRole('radio', { name: 'mm' }));
      }
      fireEvent.click(screen.getByRole('button', { name: 'Apply total' }));
      const expected = 35 - 35.00168;
      expect(onCommit).toHaveBeenCalledWith(expected, String(expected));
      expect(onCancel).not.toHaveBeenCalled();
    }
  );
  it('accepts the first rig anchor after the initial resize notification, then stays anchored on resize', () => {
    let notify = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
    const host = document.createElement('div');
    Object.defineProperties(host, {
      clientWidth: { value: 1000, configurable: true },
      clientHeight: { value: 800 }
    });
    document.body.append(host);
    const anchor = {
      current: null as ((point: { x: number; y: number } | null) => void) | null
    };
    const view = render(
      <NumericKeypad
        request={{
          kind: 'offset',
          label: 'Height',
          initial: '10',
          unitKind: 'length'
        }}
        units="mm"
        scope={{}}
        anchorRef={anchor}
        onPreview={() => undefined}
        onCommit={() => undefined}
        onCancel={() => undefined}
      />,
      { container: host }
    );
    try {
      const keypad = screen.getByRole('dialog', { name: 'Height value' });
      notify(); // ResizeObserver delivers once even without a size change.
      anchor.current?.({ x: 800, y: 100 });
      // No chip to stand in for: it stands under the anchor point.
      expect(keypad).toHaveStyle({ left: '684px', top: '114px' });
      // Frozen while editing: a later anchor push does not move it.
      anchor.current?.({ x: 200, y: 400 });
      expect(keypad).toHaveStyle({ left: '684px', top: '114px' });
      Object.defineProperty(host, 'clientWidth', { value: 390 });
      notify();
      // A narrower host re-clamps it on screen, at the same height.
      expect(parseFloat(keypad.style.left) + 232).toBeLessThanOrEqual(382);
      anchor.current?.({ x: 200, y: 400 });
      expect(keypad.style.top).toBe('114px');
      // The anchor leaving the screen docks the control at the foot.
      anchor.current?.(null);
      expect(keypad).toHaveAttribute('data-placement', 'docked');
      expect(keypad.style.top).toBe('752px');
    } finally {
      view.unmount();
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  it('takes the place of the chip it was opened from, its row centred on it', () => {
    const host = document.createElement('div');
    Object.defineProperties(host, {
      clientWidth: { value: 1000 },
      clientHeight: { value: 800 }
    });
    document.body.append(host);
    const view = render(
      <>
        <div
          className="handle-value-chip"
          style={{ left: 500, top: 300 }}
          ref={(chip) => {
            if (chip)
              vi.spyOn(chip, 'getBoundingClientRect').mockReturnValue({
                x: 455,
                y: 274,
                left: 455,
                top: 274,
                right: 545,
                bottom: 294,
                width: 90,
                height: 20,
                toJSON: () => ({})
              });
          }}
        >
          R 0 mm
        </div>
        <NumericKeypad
          request={{
            kind: 'edge',
            label: 'Radius',
            initial: '',
            unitKind: 'length'
          }}
          units="mm"
          scope={{}}
          anchorRef={{ current: null }}
          onPreview={() => undefined}
          onCommit={() => undefined}
          onCancel={() => undefined}
        />
      </>,
      { container: host }
    );
    const keypad = screen.getByRole('dialog', { name: 'Radius value' });
    // Over the chip's painted box (455–545 × 274–294), centred on it.
    expect(keypad).toHaveStyle({
      left: '455px',
      top: '264px',
      visibility: 'visible'
    });
    expect(keypad).toHaveAttribute('data-placement', 'over');
    expect(screen.getByRole('textbox')).toHaveFocus();
    view.unmount();
    host.remove();
  });

  it('positions and focuses the input before the parent layout phase even before an anchor frame', () => {
    const observed = vi.fn();
    function Parent() {
      useLayoutEffect(() => {
        const input = document.querySelector<HTMLInputElement>('.keypad-value');
        const keypad = document.querySelector<HTMLElement>('.numeric-keypad');
        observed(
          document.activeElement === input,
          keypad?.style.visibility,
          input?.selectionStart,
          input?.selectionEnd
        );
      }, []);
      return (
        <div style={{ width: 1000, height: 800 }}>
          <NumericKeypad
            request={{
              kind: 'offset',
              label: 'Height',
              initial: '1',
              unitKind: 'length',
              selectInitial: false
            }}
            units="mm"
            scope={{}}
            anchorRef={{ current: null }}
            onPreview={() => undefined}
            onCommit={() => undefined}
            onCancel={() => undefined}
          />
        </div>
      );
    }
    render(<Parent />);
    expect(observed).toHaveBeenCalledExactlyOnceWith(true, 'visible', 1, 1);
  });

  it('keeps the caret after a captured digit and previews that digit once', () => {
    const { input, onPreview, onCommit } = setup('1', false);
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(1);
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(1);
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(10, '10');
  });

  it('allows minus and decimal prefixes to become a signed distance', () => {
    const { input, onPreview } = setup('-', false);
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '-.5' } });
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(-0.5);
  });

  it('still selects an existing measured prefill when Enter or a chip opens it', () => {
    const { input, onPreview } = setup('24');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(2);
    expect(onPreview).not.toHaveBeenCalled();
  });
});

describe('an inch document', () => {
  function renderInch(initial: string) {
    const onCommit = vi.fn();
    const request: KeypadRequest = {
      kind: 'radius',
      label: 'Radius',
      initial,
      unitKind: 'length',
      selectInitial: false
    };
    render(
      <NumericKeypad
        request={request}
        units="inch"
        scope={{}}
        anchorRef={{ current: null }}
        onPreview={vi.fn()}
        onCommit={onCommit}
        onCancel={() => undefined}
      />
    );
    return {
      input: screen.getByRole<HTMLInputElement>('textbox'),
      onCommit
    };
  }

  /*
    App.tsx prefills every keypad with a value already in document units, so
    the opening chip has to be that unit. It used to open on `mm` with no inch
    chip to move to, which silently divided a prefilled inch value by 25.4 —
    0.25 in committed as 0.00984 in.
  */
  it('commits a prefilled value unchanged instead of reading it as millimetres', () => {
    const { input, onCommit } = renderInch('0.25');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(0.25, '0.25');
  });

  it('opens on its own unit and offers it as a chip', () => {
    renderInch('0.25');
    const chips = screen
      .getByRole('radiogroup', { name: 'Entry unit' })
      .querySelectorAll('button');
    expect([...chips].map((chip) => chip.textContent)).toEqual([
      'mm',
      'cm',
      'm',
      'in'
    ]);
    expect(screen.getByRole('radio', { name: 'in' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('still rescales when the user picks a different chip', () => {
    const { input, onCommit } = renderInch('0.25');
    fireEvent.click(screen.getByRole('radio', { name: 'mm' }));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit.mock.calls[0]?.[0]).toBeCloseTo(0.25 / 25.4, 8);
  });
});

describe('a millimetre document', () => {
  it('keeps its three chips, so the inch chip is not shown where it means nothing', () => {
    setup('10', false);
    const chips = screen
      .getByRole('radiogroup', { name: 'Entry unit' })
      .querySelectorAll('button');
    expect([...chips].map((chip) => chip.textContent)).toEqual([
      'mm',
      'cm',
      'm'
    ]);
  });
});

describe('keyboard on the chips and keys', () => {
  /*
    Enter anywhere in the pad committed: a keyboard user who Tabbed to `cm`
    and pressed Enter applied 12 as 12 mm, in the unit they were moving away
    from, instead of pressing the chip.
  */
  it('lets Enter press a focused chip or key instead of committing', () => {
    const { input, onCommit } = setup('12');
    const cm = screen.getByRole('radio', { name: 'cm' });
    cm.focus();
    // Not prevented, so the browser turns it into the chip's click.
    expect(fireEvent.keyDown(cm, { key: 'Enter' })).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
    const seven = screen.getByRole('button', { name: '7' });
    expect(fireEvent.keyDown(seven, { key: 'Enter' })).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.click(cm);
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(120, '120');
  });

  it('crosses a radio group with one Tab stop and moves through it with arrows', () => {
    setup('12');
    const [mm, cm, m] = ['mm', 'cm', 'm'].map((name) =>
      screen.getByRole('radio', { name })
    );
    expect(mm).toHaveAttribute('tabindex', '0');
    expect(cm).toHaveAttribute('tabindex', '-1');
    expect(m).toHaveAttribute('tabindex', '-1');

    mm!.focus();
    fireEvent.keyDown(mm!, { key: 'ArrowRight' });
    expect(cm).toHaveFocus();
    expect(cm).toHaveAttribute('aria-checked', 'true');
    expect(cm).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(cm!, { key: 'ArrowLeft' });
    fireEvent.keyDown(mm!, { key: 'ArrowLeft' });
    expect(m).toHaveFocus();
    expect(m).toHaveAttribute('aria-checked', 'true');
  });
});

describe('the converted value under the field', () => {
  it('shows a plain number typed under another unit in document units', () => {
    const { input } = setup('12', false);
    expect(screen.queryByText(/^=/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'cm' }));
    expect(screen.getByText('= 120 mm')).toBeTruthy();
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByText(/^=/)).toBeNull();
  });

  it('names an inch document’s unit as its chip does', () => {
    render(
      <NumericKeypad
        request={{
          kind: 'offset',
          label: 'Height',
          initial: '10',
          unitKind: 'length',
          selectInitial: false
        }}
        units="inch"
        scope={{}}
        anchorRef={{ current: null }}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
        onCancel={() => undefined}
      />
    );
    fireEvent.click(screen.getByRole('radio', { name: 'mm' }));
    expect(screen.getByText('= 0.394 in')).toBeTruthy();
  });
});

describe('a previewed expression', () => {
  it('is handed over as typed, a plain number as a value alone', () => {
    const { input, onPreview } = setup('');
    fireEvent.change(input, { target: { value: '4 + 8' } });
    expect(onPreview).toHaveBeenLastCalledWith(12, '4 + 8');
    fireEvent.change(input, { target: { value: '7' } });
    expect(onPreview).toHaveBeenLastCalledWith(7);
  });
});

describe('an entry that does not evaluate', () => {
  it('says so to the host until it does, and clears when the keypad closes', () => {
    const onEntryError = vi.fn();
    const view = render(
      <NumericKeypad
        request={{
          kind: 'extrude',
          commandValueId: 'distance',
          label: 'Distance',
          initial: '10',
          unitKind: 'length'
        }}
        units="mm"
        scope={{}}
        anchorRef={{ current: null }}
        onPreview={vi.fn()}
        onEntryError={onEntryError}
        onCommit={vi.fn()}
        onCancel={() => undefined}
      />
    );
    expect(onEntryError).toHaveBeenLastCalledWith(null);
    const input = screen.getByRole('textbox', { name: 'Distance' });
    fireEvent.change(input, { target: { value: '10+' } });
    expect(onEntryError).toHaveBeenLastCalledWith(expect.any(String));
    fireEvent.change(input, { target: { value: '12' } });
    expect(onEntryError).toHaveBeenLastCalledWith(null);
    fireEvent.change(input, { target: { value: '10+' } });
    view.unmount();
    expect(onEntryError).toHaveBeenLastCalledWith(null);
  });
});

describe('numeric keypad focus handback', () => {
  function chipAndKeypad(keyboard: boolean) {
    const chip = document.createElement('div');
    chip.textContent = '⌀ 6 mm';
    document.body.appendChild(chip);
    const open = vi.fn();
    prepareCommandChip(chip, open);
    chip.focus();
    if (keyboard) fireEvent.keyDown(chip, { key: 'Enter' });
    else fireEvent.click(chip);
    expect(open).toHaveBeenCalledOnce();
    const view = render(
      <NumericKeypad
        request={{
          kind: 'command',
          commandValueId: 'diameter',
          label: '⌀',
          initial: '6',
          unitKind: 'length'
        }}
        units="mm"
        scope={{}}
        anchorRef={{ current: null }}
        onPreview={() => undefined}
        onCommit={() => undefined}
        onCancel={() => undefined}
      />
    );
    return { chip, view };
  }

  it('hands focus back to a chip that opened it from the keyboard', async () => {
    const { chip, view } = chipAndKeypad(true);
    expect(screen.getByRole('textbox')).toHaveFocus();
    view.unmount();
    await Promise.resolve();
    expect(chip).toHaveFocus();
    chip.remove();
  });

  it('leaves focus alone after a pointer opening, so Enter still finishes', async () => {
    const { chip, view } = chipAndKeypad(false);
    view.unmount();
    await Promise.resolve();
    expect(chip).not.toHaveFocus();
    chip.remove();
  });
});

describe('numeric keypad names', () => {
  it('names a glyph-labelled value in words', () => {
    render(
      <NumericKeypad
        request={{
          kind: 'command',
          label: '⌀',
          initial: '6',
          unitKind: 'length'
        }}
        units="mm"
        scope={{}}
        anchorRef={{ current: null }}
        onPreview={() => undefined}
        onCommit={() => undefined}
        onCancel={() => undefined}
      />
    );
    expect(screen.getByRole('dialog', { name: 'Diameter value' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Diameter' })).toHaveValue('6');
    // The keypad still shows the compact glyph.
    expect(screen.getByText('⌀')).toBeTruthy();
  });
});

describe('on a mouse-and-keyboard device', () => {
  beforeEach(() => stubPointer(true));

  it('folds the digits and unit chips away, keeping Apply', () => {
    setup('4');
    const toggle = screen.getByRole('button', { name: 'Keypad' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: '7' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Entry unit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply height' })).toBeEnabled();
    // Other units are typed; the unit itself says how.
    const unit = screen.getByRole('button', { name: 'mm' });
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.focus(unit);
    expect(screen.getByRole('note')).toHaveTextContent(
      'Type units or expressions: 2cm, 1in'
    );
    expect(unit).toHaveAccessibleDescription(
      'Type units or expressions: 2cm, 1in'
    );
    fireEvent.blur(unit);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: '7' })).toBeInTheDocument();
    expect(screen.getByText('Enter in')).toBeInTheDocument();
  });
});

describe('a refused value', () => {
  it('reads as refused, with Apply off and saying why', () => {
    render(
      <NumericKeypad
        request={{
          kind: 'edge',
          label: 'Radius',
          initial: '1',
          unitKind: 'length'
        }}
        units="mm"
        scope={{}}
        anchorRef={{ current: null }}
        onPreview={() => undefined}
        onCommit={() => undefined}
        onCancel={() => undefined}
        commitDisabled
        commitRefused
        commitDisabledReason="This value did not build. The note below says why."
      />
    );
    const keypad = screen.getByRole('dialog', { name: 'Radius value' });
    expect(keypad).toHaveAttribute('data-state', 'refused');
    const apply = screen.getByRole('button', { name: 'Apply radius' });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAccessibleDescription(
      'This value did not build. The note below says why.'
    );
  });

  it('stays neutral while the value is only being checked', () => {
    render(
      <NumericKeypad
        request={{
          kind: 'edge',
          label: 'Radius',
          initial: '1',
          unitKind: 'length'
        }}
        units="mm"
        scope={{}}
        anchorRef={{ current: null }}
        onPreview={() => undefined}
        onCommit={() => undefined}
        onCancel={() => undefined}
        commitDisabled
      />
    );
    expect(
      screen.getByRole('dialog', { name: 'Radius value' })
    ).toHaveAttribute('data-state', 'checking');
  });
});

describe('a value the kernel checks as it is typed', () => {
  function checked(verdict: PreviewVerdict | null = null) {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const onUiStateChange = vi.fn();
    const props = {
      request: {
        kind: 'edge',
        label: 'Radius',
        initial: '1',
        unitKind: 'length'
      } satisfies KeypadRequest,
      units: 'mm' as const,
      scope: {},
      anchorRef: { current: null },
      onPreview,
      onCommit,
      onUiStateChange,
      onCancel: () => undefined
    };
    const view = render(<NumericKeypad {...props} verdict={verdict} />);
    return {
      input: screen.getByRole<HTMLInputElement>('textbox', { name: 'Radius' }),
      apply: screen.getByRole('button', { name: 'Apply radius' }),
      keypad: screen.getByRole('dialog', { name: 'Radius value' }),
      onPreview,
      onCommit,
      onUiStateChange,
      rerender: (next: PreviewVerdict | null) =>
        view.rerender(<NumericKeypad {...props} verdict={next} />)
    };
  }

  it('reads Checking… with Apply off until the typed value has built', () => {
    const { input, apply, keypad, rerender } = checked();
    // The untouched prefill is what the model already is.
    expect(keypad).toHaveAttribute('data-state', 'ready');
    fireEvent.change(input, { target: { value: '2' } });
    expect(keypad).toHaveAttribute('data-state', 'checking');
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    expect(apply).toBeDisabled();
    rerender({ value: 2, status: 'built' });
    expect(keypad).toHaveAttribute('data-state', 'ready');
    expect(apply).toBeEnabled();
  });

  it('never commits an earlier value’s preview against newer input', () => {
    const { input, apply, onCommit, rerender } = checked();
    fireEvent.change(input, { target: { value: '2' } });
    rerender({ value: 2, status: 'built' });
    fireEvent.change(input, { target: { value: '25' } });
    // 2 built; 25 has no verdict yet, so Apply waits.
    expect(apply).toBeDisabled();
    fireEvent.click(apply);
    expect(onCommit).not.toHaveBeenCalled();
    // Enter hands over 25 itself, for the host to check exactly before it
    // applies anything; 2's preview never stands in for it.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(25, '25');
  });

  it('does nothing on Enter for a refused value or while a commit is checked', () => {
    const { input, onCommit, rerender } = checked();
    fireEvent.change(input, { target: { value: '9' } });
    rerender({ value: 9, status: 'refused' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('reports its state for the key hints, and nothing once closed', () => {
    const { input, onUiStateChange } = checked();
    expect(onUiStateChange).toHaveBeenLastCalledWith({
      state: 'ready',
      explaining: false
    });
    fireEvent.change(input, { target: { value: '2+' } });
    expect(onUiStateChange).toHaveBeenLastCalledWith({
      state: 'invalid',
      explaining: false
    });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/./);
    cleanup();
    expect(onUiStateChange).toHaveBeenLastCalledWith(null);
  });
});

describe('a refusal on the control', () => {
  const operation = (
    error: CommandDiagnostic,
    extra: Partial<SelectionCalloutOperation> = {}
  ): SelectionCalloutOperation => ({
    title: 'Fillet',
    error,
    onEditCulprit: vi.fn(),
    onViewDetails: vi.fn(),
    onKeepLastValid: vi.fn(),
    onSelectAllEdges: vi.fn(),
    ...extra
  });
  const structural: CommandDiagnostic = {
    message:
      'Fillet could not be created on the selected closed edge with radius 1. The modeling engine could not trim the cylindrical face beside it. Smaller radii failed too, so a different size is unlikely to help.',
    detail: 'trimming-failure: blend: trimming failure on face Id(9)',
    advice: {
      operation: 'fillet',
      edges: 1,
      kind: 'structural',
      cause: 'trim-face',
      reason:
        'The modeling engine could not trim the cylindrical face beside it. Smaller radii failed too, so a different size is unlikely to help.'
    }
  };

  function refused(
    error: CommandDiagnostic,
    extra: Partial<SelectionCalloutOperation> = {}
  ) {
    const onCancel = vi.fn();
    const onPreview = vi.fn();
    const onPickAnother = vi.fn();
    const op = operation(error, extra);
    render(
      <NumericKeypad
        request={{
          kind: 'edge',
          label: 'Radius',
          initial: '1',
          selectInitial: false,
          unitKind: 'length'
        }}
        units="mm"
        scope={{}}
        anchorRef={{ current: null }}
        onPreview={onPreview}
        onCommit={vi.fn()}
        onCancel={onCancel}
        verdict={{ value: 1, status: 'refused' }}
        commitRefused
        commitDisabled
        refusal={{
          operation: op,
          onPickAnother,
          pickAnotherLabel: 'Pick another edge'
        }}
      />
    );
    return { onCancel, onPreview, onPickAnother, op };
  }

  it('says Not built in one live line, with the controls outside it', () => {
    refused(structural);
    const keypad = screen.getByRole('dialog', { name: 'Radius value' });
    expect(keypad).toHaveAttribute('data-state', 'refused');
    const line = screen.getByRole('alert');
    expect(line).toHaveTextContent(
      'Not builtCan’t round this edge hereSolid unchanged'
    );
    expect(line.querySelector('button')).toBeNull();
    const input = screen.getByRole('textbox', { name: 'Radius' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    // The error is the field's description: the live line itself.
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(
      line.id
    );
    expect(screen.getByRole('button', { name: 'Apply radius' })).toBeDisabled();
    // Size was ruled out: no size is offered.
    expect(screen.queryByRole('button', { name: /^Try / })).toBeNull();
  });

  it('opens Why? in place, and Escape closes it before it cancels the edit', () => {
    const { onCancel, onPickAnother, op } = refused(structural, {
      keepLastValidLabel: 'Keep 0.5 mm'
    });
    expect(screen.getByRole('button', { name: 'Keep 0.5 mm' })).toBeVisible();
    const why = screen.getByRole('button', { name: 'Why?' });
    fireEvent.click(why);
    expect(why).toHaveAttribute('aria-expanded', 'true');
    const card = screen.getByRole('group', {
      name: 'Can’t round this edge here'
    });
    expect(card).toHaveTextContent(
      'The modeling engine could not trim the cylindrical face beside it.'
    );
    // Remedies are the verified ones only.
    fireEvent.click(screen.getByRole('button', { name: 'Pick another edge' }));
    expect(onPickAnother).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Technical details' }));
    expect(op.onViewDetails).toHaveBeenCalledOnce();

    const input = screen.getByRole('textbox', { name: 'Radius' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('group')).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('names the feature to edit when the refusal names one', () => {
    const { op } = refused({
      ...structural,
      culprit: { featureId: 'f-1', featureName: 'Fillet edges 2' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Why?' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit “Fillet edges 2”' })
    );
    expect(op.onEditCulprit).toHaveBeenCalledWith('f-1');
  });

  it('offers the size the ladder built, and only that one', () => {
    const { onPreview } = refused({
      message:
        'Fillet could not be created on 1 selected edge with radius 5. Try a smaller radius: radius 2.5 builds here.',
      advice: {
        operation: 'fillet',
        edges: 1,
        kind: 'smaller-size',
        size: 2.5,
        reason: 'Radius 5 is too large here; radius 2.5 builds.'
      }
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Radius too large');
    fireEvent.click(screen.getByRole('button', { name: 'Try 2.5 mm' }));
    expect(onPreview).toHaveBeenLastCalledWith(2.5);
    expect(screen.getByRole('textbox', { name: 'Radius' })).toHaveValue('2.5');
  });
});

describe('the unit help and the Escape ladder', () => {
  it('closes the unit help first, then cancels the edit', () => {
    const onCancel = vi.fn();
    render(
      <NumericKeypad
        request={{
          kind: 'offset',
          label: 'Offset',
          initial: '4',
          unitKind: 'length'
        }}
        units="mm"
        scope={{}}
        anchorRef={{ current: null }}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'mm' }));
    expect(screen.getByRole('note')).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: 'Offset' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('note')).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows an expression or another unit evaluated in document units, inline', () => {
    setup('', false);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '2cm' }
    });
    expect(screen.getByText('= 20 mm')).toBeInTheDocument();
  });
});

describe('the keypad behind its overflow action', () => {
  beforeEach(() => {
    stubPointer(true);
    resetKeypadPointerForTests();
  });

  it('stays folded after a mouse opening', () => {
    fireEvent.pointerDown(document.body, { pointerType: 'mouse' });
    setup('4');
    expect(screen.getByRole('button', { name: 'Keypad' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('opens for a touch opening on a hybrid device with a fine primary pointer', () => {
    fireEvent.pointerDown(document.body, { pointerType: 'touch' });
    setup('4');
    expect(screen.getByRole('button', { name: 'Keypad' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByRole('button', { name: '7' })).toBeInTheDocument();
  });
});

describe('help shown by hovering the unit', () => {
  it('does not take the Escape that cancels the edit', () => {
    const onCancel = vi.fn();
    render(
      <NumericKeypad
        request={{
          kind: 'offset',
          label: 'Total',
          initial: '28',
          unitKind: 'length'
        }}
        units="mm"
        scope={{}}
        anchorRef={{ current: null }}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
        onCancel={onCancel}
      />
    );
    // The control opens under the pointer that pressed the chip.
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'mm' }));
    expect(screen.getByRole('note')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Total' }), {
      key: 'Escape'
    });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe('the operation switch, away from the pick', () => {
  /** Answers the phone query as `phone` says, and a touch pointer. */
  function stubPhone(phone: boolean) {
    window.matchMedia = (query: string) => ({
      matches: query === '(max-width: 560px)' ? phone : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false
    });
  }

  /**
   * A host holding the viewport's operation tag, which switches between its
   * two operations when pressed, as the edge's Fillet/Chamfer tag does.
   */
  function mount(
    request: KeypadRequest,
    tagText: string | null,
    other = 'Chamfer ▾'
  ) {
    const host = document.createElement('div');
    Object.defineProperties(host, {
      clientWidth: { value: 1000, configurable: true },
      clientHeight: { value: 800 }
    });
    document.body.append(host);
    const onTag = vi.fn();
    // The viewport draws the tag outside React and rewrites its text; the
    // test does the same, through a ref, beside the control.
    const attachTag = (tag: HTMLSpanElement | null) => {
      if (!tag || tagText === null || tag.dataset.testid) return;
      tag.dataset.testid = 'direct-manipulation-mode';
      tag.textContent = tagText;
      tag.addEventListener('click', () => {
        onTag();
        tag.textContent = tag.textContent === tagText ? other : tagText;
      });
    };
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const anchor = {
      current: null as ((point: { x: number; y: number } | null) => void) | null
    };
    const view = render(
      <>
        {tagText !== null && (
          <span className="handle-label-chip" role="button" ref={attachTag} />
        )}
        <NumericKeypad
          request={request}
          units="mm"
          scope={{}}
          anchorRef={anchor}
          onPreview={() => undefined}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </>,
      { container: host }
    );
    return {
      anchor,
      onTag,
      onCommit,
      onCancel,
      keypad: () => screen.getByRole('dialog'),
      done: () => {
        view.unmount();
        host.remove();
      }
    };
  }

  const edge: KeypadRequest = {
    kind: 'edge',
    label: 'Radius',
    initial: '2',
    unitKind: 'length'
  };

  it('reads a switch from the tag’s ▾, and nothing from a name alone', () => {
    const tag = document.createElement('span');
    tag.textContent = 'Fillet ▾';
    expect(operationTagLabel(tag)).toBe('Fillet');
    tag.textContent = ' Total ▾ ';
    expect(operationTagLabel(tag)).toBe('Total');
    tag.textContent = 'Diameter';
    expect(operationTagLabel(tag)).toBeNull();
    tag.textContent = '▾';
    expect(operationTagLabel(tag)).toBeNull();
    expect(operationTagLabel(null)).toBeNull();
  });

  it('leads the phone sheet with the operation, which switches without applying', async () => {
    stubPhone(true);
    const view = mount(edge, 'Fillet ▾');
    try {
      const keypad = view.keypad();
      expect(keypad).toHaveAttribute('data-placement', 'sheet');
      // The tag at the pick steps aside for the one in the sheet.
      expect(keypad).toHaveAttribute('data-operation', '');
      const row = keypad.querySelector('.keypad-value-row')!;
      const segment = within(keypad).getByRole('button', { name: 'Fillet' });
      expect(row.firstElementChild).toBe(segment);
      fireEvent.click(segment);
      expect(view.onTag).toHaveBeenCalledTimes(1);
      expect(view.onCommit).not.toHaveBeenCalled();
      expect(view.onCancel).not.toHaveBeenCalled();
      // It says what the tag says once the switch is made.
      expect(
        await within(keypad).findByRole('button', { name: 'Chamfer' })
      ).toBeInTheDocument();
    } finally {
      view.done();
    }
  });

  it('comes along when the control docks at the foot of the stage', () => {
    stubPhone(false);
    const view = mount(edge, 'Fillet ▾');
    try {
      const keypad = view.keypad();
      act(() => view.anchor.current?.({ x: 500, y: 300 }));
      // Beside the pick the tag there is the switch; the control has none.
      expect(keypad).not.toHaveAttribute('data-placement', 'docked');
      expect(
        within(keypad).queryByRole('button', { name: 'Fillet' })
      ).toBeNull();
      expect(keypad).not.toHaveAttribute('data-operation');
      act(() => view.anchor.current?.(null));
      expect(keypad).toHaveAttribute('data-placement', 'docked');
      expect(keypad).toHaveAttribute('data-operation', '');
      fireEvent.click(within(keypad).getByRole('button', { name: 'Fillet' }));
      expect(view.onTag).toHaveBeenCalledTimes(1);
      expect(view.onCommit).not.toHaveBeenCalled();
      // Enter in the field still applies; the segment never did.
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
      expect(view.onCommit).toHaveBeenCalledTimes(1);
    } finally {
      view.done();
    }
  });

  it('carries the Total/Offset switch of a face offset too', () => {
    stubPhone(true);
    const view = mount(
      { kind: 'offset', label: 'Total', initial: '10', unitKind: 'length' },
      'Total ▾',
      'Offset ▾'
    );
    try {
      fireEvent.click(
        within(view.keypad()).getByRole('button', { name: 'Total' })
      );
      expect(view.onTag).toHaveBeenCalledTimes(1);
      expect(view.onCommit).not.toHaveBeenCalled();
    } finally {
      view.done();
    }
  });

  it('adds nothing for a tag that only names the value, or an entry without one', () => {
    stubPhone(true);
    const named = mount(
      {
        kind: 'radius',
        label: 'Radius',
        initial: '5',
        unitKind: 'length',
        dimensionMode: 'radius'
      },
      'Radius'
    );
    try {
      expect(named.keypad()).not.toHaveAttribute('data-operation');
      expect(named.keypad().querySelector('.keypad-operation')).toBeNull();
    } finally {
      named.done();
    }
    // A sketch dimension never switches, whatever a stale tag still says.
    const sketch = mount(
      {
        kind: 'sketch-dimension',
        label: 'Length',
        initial: '5',
        unitKind: 'length'
      },
      'Fillet ▾'
    );
    try {
      expect(sketch.keypad().querySelector('.keypad-operation')).toBeNull();
    } finally {
      sketch.done();
    }
  });
});
