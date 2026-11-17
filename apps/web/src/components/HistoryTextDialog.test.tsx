import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  setParameter
} from '@openzcad/document-core';
import { readHistoryText } from '@openzcad/scripting';
import { toUserId } from '@openzcad/shared';
import HistoryTextDialog from './HistoryTextDialog';

function block(width: string) {
  let document = createProjectDocument('Bracket', toUserId('owner'));
  document = setParameter(document, {
    name: 'width',
    expression: width,
    quantity: 'length'
  });
  return addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 20, depth: 10 }
  });
}

describe('HistoryTextDialog', () => {
  it('shows the history as text that reads back to the same document', () => {
    const document = block('40 mm');
    render(<HistoryTextDialog document={document} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'History as text' });
    expect(dialog).toHaveAccessibleDescription(
      /Every parameter and step of Bracket/
    );
    const body = screen.getByLabelText(/History text, \d+ lines/);
    expect(body.textContent).toMatch(
      /param #param_\S+ width: length = `40 mm`/
    );
    expect(body.textContent).toMatch(
      /primitive #feat_\S+ "Block" -> #body_\S+/
    );
    const read = readHistoryText(body.textContent, document);
    expect(read.diagnostics).toEqual([]);
  });

  it('follows an edit made in the app', () => {
    const document = block('40 mm');
    const view = render(
      <HistoryTextDialog document={document} onClose={vi.fn()} />
    );
    const edited = structuredClone(document);
    const parameter = Object.values(edited.nodes).find(
      (node) => node.kind === 'parameter'
    )!;
    if (parameter.kind !== 'parameter') throw new Error('fixture');
    parameter.expression = '55 mm';
    view.rerender(<HistoryTextDialog document={edited} onClose={vi.fn()} />);
    expect(screen.getByLabelText(/History text/).textContent).toContain(
      'width: length = `55 mm`'
    );
  });

  it('copies the text and closes on Escape and Close', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const onClose = vi.fn();
    const document = block('40 mm');
    render(<HistoryTextDialog document={document} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(
      screen.getByLabelText(/History text/).textContent
    );
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
    await act(async () => {
      await user.keyboard('{Escape}');
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('says so when copying is refused', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
    });
    render(<HistoryTextDialog document={block('40 mm')} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Copy failed; select the text instead.'
    );
  });
});
