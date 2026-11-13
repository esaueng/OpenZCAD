import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AssemblyPanelPending } from './AssemblyPanelPending';

describe('Assemble sidebar while it loads', () => {
  it('stands in as a busy Assembly panel that says it is loading', () => {
    render(<AssemblyPanelPending />);
    const panel = screen.getByRole('complementary', { name: 'Assembly' });
    expect(panel).toHaveAttribute('aria-busy', 'true');
    expect(panel).toHaveClass('assembly-panel');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading parts and joints…'
    );
  });
});
