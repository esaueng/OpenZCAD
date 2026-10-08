import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useLayoutEffect } from 'react';
import { NumericKeypad, type KeypadRequest } from './NumericKeypad';

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
  it('uses the rig anchor rather than the transformed chip bounds for its first placement', () => {
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
    expect(keypad).toHaveStyle({
      left: '384px',
      top: '314px',
      visibility: 'visible'
    });
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
