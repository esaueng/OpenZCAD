import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
