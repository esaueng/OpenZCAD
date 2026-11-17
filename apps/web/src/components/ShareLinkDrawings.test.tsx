import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ShareLinkDrawings } from './ShareLinkDrawings';

const sheets = [
  { id: 'dsht_a', name: 'Assembly' },
  { id: 'dsht_b', name: 'Detail' }
];

describe('ShareLinkDrawings', () => {
  it('ticks a sheet onto the links and off again, in sheet order', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <ShareLinkDrawings
        sheets={sheets}
        sharedSheetIds={['dsht_b']}
        onChange={onChange}
      />
    );
    expect(
      screen.getByRole('region', { name: 'Drawings on links' })
    ).toHaveTextContent('Title blocks show as drawn');
    expect(screen.getByRole('checkbox', { name: 'Detail' })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Assembly' }));
    expect(onChange).toHaveBeenLastCalledWith(['dsht_a', 'dsht_b']);
    rerender(
      <ShareLinkDrawings
        sheets={sheets}
        sharedSheetIds={['dsht_a', 'dsht_b']}
        onChange={onChange}
      />
    );
    await user.click(screen.getByRole('checkbox', { name: 'Detail' }));
    expect(onChange).toHaveBeenLastCalledWith(['dsht_a']);
  });

  it('only shows the choice where the project cannot be edited', () => {
    render(<ShareLinkDrawings sheets={sheets} sharedSheetIds={['dsht_a']} />);
    expect(screen.getByRole('checkbox', { name: 'Assembly' })).toBeDisabled();
  });
});
