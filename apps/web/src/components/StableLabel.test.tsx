import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StableLabel } from './StableLabel';

describe('StableLabel', () => {
  it('reserves the longest label without putting it in the text', () => {
    render(
      <button type="button">
        <StableLabel reserve={['Saving', 'Saved', 'Local only']}>
          Saved
        </StableLabel>
      </button>
    );
    // The accessible name and text content stay the visible label alone, so
    // getByRole/name lookups and toHaveText assertions are unaffected.
    const button = screen.getByRole('button', { name: 'Saved' });
    expect(button).toHaveTextContent(/^Saved$/);
    const slot = button.querySelector('.stable-label');
    expect(slot).toHaveAttribute('data-reserve', 'Local only');
  });

  it('centres on request', () => {
    const { container } = render(
      <StableLabel reserve={['Copy', 'Copied']} align="center">
        Copy
      </StableLabel>
    );
    expect(container.querySelector('.stable-label-center')).not.toBeNull();
  });
});
