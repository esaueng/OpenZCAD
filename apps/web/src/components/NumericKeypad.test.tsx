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
    input: screen.getByRole<HTMLInputElement>('textbox'),
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
