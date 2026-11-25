import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ShareLinkCard,
  ShareLinkComposer,
  ShareLinkCopyButton
} from './ShareLinkCard';

describe('ShareLinkCard', () => {
  it('names the link on its toggle and shows its actions only while open', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <ul>
        <ShareLinkCard
          name="Client review"
          summary="Tweak · Expires in 30d"
          mode="tweak"
          expanded={false}
          onToggle={onToggle}
        >
          <button type="button">Revoke</button>
        </ShareLinkCard>
      </ul>
    );
    const toggle = screen.getByRole('button', { name: 'Client review' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAccessibleDescription('Tweak · Expires in 30d');
    expect(
      screen.queryByRole('button', { name: 'Revoke' })
    ).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledOnce();

    rerender(
      <ul>
        <ShareLinkCard
          name="Client review"
          summary="Tweak · Expires in 30d"
          mode="tweak"
          expanded
          onToggle={onToggle}
        >
          <button type="button">Revoke</button>
        </ShareLinkCard>
      </ul>
    );
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeVisible();
  });
});

describe('ShareLinkCopyButton', () => {
  it('says Copied only when the copy went through', async () => {
    const onCopy = vi
      .fn<(url: string, row: string | null) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    render(<ShareLinkCopyButton url="https://x/#share=a" onCopy={onCopy} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenLastCalledWith('https://x/#share=a', null);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible();
  });

  it('offers no configuration menu without configurations', () => {
    render(
      <ShareLinkCopyButton
        url="https://x/#share=a"
        name="View only link"
        onCopy={vi.fn(async () => true)}
      />
    );
    expect(
      screen.getByRole('button', { name: 'Copy View only link' })
    ).toBeVisible();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('copies a link opening on the configuration picked from its menu, by keyboard', async () => {
    const onCopy = vi.fn(async () => true);
    const user = userEvent.setup();
    render(
      <ShareLinkCopyButton
        url="https://x/#share=a"
        configurations={[
          { id: 'small', name: 'Small' },
          { id: 'large', name: 'Large' }
        ]}
        onCopy={onCopy}
      />
    );
    const caret = screen.getByRole('button', {
      name: 'Copy link opening on a configuration'
    });
    await user.click(caret);
    expect(caret).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'The saved configuration',
      'Small',
      'Large'
    ]);
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(items[2]).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onCopy).toHaveBeenCalledWith('https://x/#share=a', 'small');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    // The keyboard goes back to the control that opened the menu.
    expect(caret).toHaveFocus();
  });

  it('closes its menu on a click outside it', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ShareLinkCopyButton
          url="https://x/#share=a"
          configurations={[{ id: 'small', name: 'Small' }]}
          onCopy={vi.fn(async () => true)}
        />
        <p>Elsewhere</p>
      </>
    );
    await user.click(
      screen.getByRole('button', {
        name: 'Copy link opening on a configuration'
      })
    );
    expect(screen.getByRole('menu')).toBeVisible();
    await user.click(screen.getByText('Elsewhere'));
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    );
  });
});

describe('ShareLinkComposer', () => {
  // L11 (§4): Create link makes a link at once; the options wait behind
  // Options….
  it.each([
    [true, { mode: 'view', comments: false, history: false, name: '' }],
    [false, { mode: 'view', comments: false, history: true, name: '' }]
  ] as const)(
    'creates a view-only link in one click (history can be left out: %s)',
    async (canExcludeHistory, draft) => {
      const onCreate = vi.fn();
      const onExpandedChange = vi.fn();
      const user = userEvent.setup();
      render(
        <ShareLinkComposer
          canExcludeHistory={canExcludeHistory}
          expanded={false}
          onExpandedChange={onExpandedChange}
          nameable
          commentsHint="Visitors see only this link’s comments."
          footnote="End-to-end encrypted: the key is in the link."
          onCreate={onCreate}
        />
      );
      expect(
        screen.queryByRole('textbox', { name: 'Link name' })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('checkbox', { name: 'Visitors can comment' })
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Create link' }));
      expect(onCreate).toHaveBeenCalledOnce();
      expect(onCreate).toHaveBeenCalledWith(draft);
      const options = screen.getByRole('button', { name: 'Options…' });
      expect(options).toHaveAttribute('aria-expanded', 'false');
      await user.click(options);
      expect(onExpandedChange).toHaveBeenCalledWith(true);
    }
  );

  it('waits on a history blocker in one click only where history must stay', async () => {
    const blocker = <p role="alert">Save the source files first.</p>;
    const { rerender } = render(
      <ShareLinkComposer
        canExcludeHistory
        expanded={false}
        onExpandedChange={vi.fn()}
        nameable
        commentsHint="Visitors see only this link’s comments."
        footnote="Links expire after 30 days."
        historyBlocker={blocker}
        onCreate={vi.fn()}
      />
    );
    // The one-click link leaves history out, so nothing blocks it.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create link' })).toBeEnabled();
    rerender(
      <ShareLinkComposer
        canExcludeHistory={false}
        expanded={false}
        onExpandedChange={vi.fn()}
        nameable
        commentsHint="Visitors see only this link’s comments."
        footnote="Links expire after 30 days."
        historyBlocker={blocker}
        onCreate={vi.fn()}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Save the source files first.'
    );
    expect(screen.getByRole('button', { name: 'Create link' })).toBeDisabled();
  });

  it('waits on a history blocker only while history is included', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(
      <ShareLinkComposer
        canExcludeHistory
        expanded
        onExpandedChange={vi.fn()}
        nameable
        commentsHint="Visitors see only this link’s comments."
        footnote="Links expire after 30 days."
        historyBlocker={<p role="alert">Save the source files first.</p>}
        onCreate={onCreate}
      />
    );
    const create = screen.getByRole('button', { name: 'Create link' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Save the source files first.'
    );
    expect(create).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Include history' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.type(
      screen.getByRole('textbox', { name: 'Link name' }),
      'Fab shop'
    );
    await user.click(create);
    expect(onCreate).toHaveBeenCalledWith({
      mode: 'view',
      comments: false,
      history: false,
      name: 'Fab shop'
    });
  });

  it('keeps its options usable while only Create link waits', async () => {
    const onCreate = vi.fn();
    const onExpandedChange = vi.fn();
    render(
      <ShareLinkComposer
        canExcludeHistory={false}
        expanded
        onExpandedChange={onExpandedChange}
        nameable={false}
        createDisabled
        commentsHint="Visitors see only this link’s comments."
        footnote="End-to-end encrypted: the key is in the link."
        onCreate={onCreate}
      />
    );
    expect(
      screen.queryByRole('textbox', { name: 'Link name' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'Include history' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'Visitors can comment' })
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Create link' })).toBeDisabled();
    // Cancel closes the options back to one-click Create link.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onExpandedChange).toHaveBeenCalledWith(false);
    expect(onCreate).not.toHaveBeenCalled();
  });
});
