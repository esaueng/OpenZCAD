import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  setParameter
} from '@openzcad/document-core';
import type { CadPatchProposal } from '@openzcad/ai-contracts';
import { readHistoryText } from '@openzcad/scripting';
import { toUserId } from '@openzcad/shared';
import HistoryTextDialog from './HistoryTextDialog';
import type { PatchSource } from './modelPanels/modelPanelProps';

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

function textArea(): HTMLTextAreaElement {
  return screen.getByLabelText(/History text, \d+ lines/);
}

function type(value: string) {
  fireEvent.change(textArea(), { target: { value } });
}

describe('HistoryTextDialog', () => {
  it('shows the history as text that reads back to the same document', () => {
    const document = block('40 mm');
    render(<HistoryTextDialog document={document} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'History as text' });
    expect(dialog).toHaveAccessibleDescription(
      /Every parameter and step of Bracket.*read only/
    );
    expect(textArea().value).toMatch(
      /param #param_\S+ width: length = `40 mm`/
    );
    expect(textArea().value).toMatch(
      /primitive #feat_\S+ "Block" -> #body_\S+/
    );
    expect(textArea()).toHaveAttribute('readonly');
    expect(readHistoryText(textArea().value, document).diagnostics).toEqual([]);
    // Read only: no editing actions.
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('follows an edit made in the app while the text is unedited', () => {
    const document = block('40 mm');
    const view = render(
      <HistoryTextDialog
        document={document}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    );
    view.rerender(
      <HistoryTextDialog
        document={{ ...block('55 mm'), version: document.version + 1 }}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(textArea().value).toContain('width: length = `55 mm`');
  });

  it('checks an edit, lists its problems by line and applies a clean one', async () => {
    const user = userEvent.setup();
    const document = block('40 mm');
    const onApply = vi.fn().mockResolvedValue(true);
    render(
      <HistoryTextDialog
        document={document}
        onApply={onApply}
        onClose={vi.fn()}
      />
    );
    const original = textArea().value;
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

    type(original.replace('height: 20', 'height: `30 deg`'));
    await user.click(screen.getByRole('button', { name: 'Check' }));
    const problems = screen.getByRole('list', { name: 'Problems' });
    expect(problems).toHaveTextContent(/Line \d+, column \d+/);
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 problem to fix before applying.'
    );
    expect(textArea()).toHaveAttribute('aria-invalid', 'true');
    await user.click(
      screen.getByRole('button', { name: /Line \d+, column \d+/ })
    );
    expect(
      textArea().value.slice(textArea().selectionStart, textArea().selectionEnd)
    ).toBe('`30 deg`');

    type(original.replace('height: 20', 'height: 25'));
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(screen.getByRole('list', { name: 'Changes' })).toHaveTextContent(
      'Edit Block: dimensions'
    );
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const [proposal, source] = onApply.mock.calls[0]! as [
      CadPatchProposal,
      PatchSource
    ];
    expect(source).toMatchObject({
      label: 'Edit history text',
      baseVersion: document.version
    });
    expect(proposal.operations).toEqual([
      expect.objectContaining({
        kind: 'update_feature',
        data: { dimensions: { width: 'width', height: 25, depth: 10 } }
      })
    ]);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Applied as one undo step.'
    );
  });

  it('keeps an edit, and refuses to apply it, once the model changes under it', async () => {
    const user = userEvent.setup();
    const document = block('40 mm');
    const onApply = vi.fn();
    const view = render(
      <HistoryTextDialog
        document={document}
        onApply={onApply}
        onClose={vi.fn()}
      />
    );
    const edited = textArea().value.replace('height: 20', 'height: 25');
    type(edited);
    view.rerender(
      <HistoryTextDialog
        document={{ ...document, version: document.version + 1 }}
        onApply={onApply}
        onClose={vi.fn()}
      />
    );
    expect(textArea().value).toBe(edited);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The model changed since you started editing.'
    );
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Reload text' }));
    expect(textArea().value).not.toBe(edited);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('cannot apply while editing is blocked, and says why', () => {
    render(
      <HistoryTextDialog
        document={block('40 mm')}
        editBlocked="View mode is read-only — switch to Build to edit"
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    );
    type(textArea().value.replace('height: 20', 'height: 25'));
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAttribute(
      'title',
      'View mode is read-only — switch to Build to edit'
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
    render(<HistoryTextDialog document={block('40 mm')} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(textArea().value);
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
