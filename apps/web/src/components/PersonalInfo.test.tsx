import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { PrivateEmailInput, PrivateText, standInFor } from './PersonalInfo';

function EmailForm() {
  const [visible, setVisible] = useState(false);
  const [email, setEmail] = useState('');
  return (
    <form>
      <PrivateText
        value="saved@example.com"
        visible={visible}
        onChange={setVisible}
      />
      <PrivateEmailInput
        visible={visible}
        required
        aria-label="Email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
    </form>
  );
}

describe('private email input', () => {
  it('masks input and keeps email validation and the value through toggles', async () => {
    const user = userEvent.setup();
    render(<EmailForm />);
    const input = screen.getByLabelText<HTMLInputElement>('Email');
    expect(input).toHaveAttribute('type', 'password');
    expect(input.checkValidity()).toBe(false);
    await user.type(input, 'invalid');
    expect(input.checkValidity()).toBe(false);
    expect(input.validationMessage).not.toContain('invalid');
    await user.clear(input);
    await user.type(input, 'person@example.com');
    expect(input.checkValidity()).toBe(true);
    await user.click(
      screen.getByRole('button', { name: 'Show personal info' })
    );
    expect(input).toHaveAttribute('type', 'email');
    expect(input).toHaveValue('person@example.com');
    expect(input.checkValidity()).toBe(true);
    await user.click(
      screen.getByRole('button', { name: 'saved@example.com' })
    );
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveValue('person@example.com');
    expect(input.checkValidity()).toBe(true);
  });
});

// Design review I78: a masked field hid typos from the person typing.
describe('private email input while typing', () => {
  it('shows what is typed while focused and masks it again on blur', async () => {
    const user = userEvent.setup();
    render(<EmailForm />);
    const input = screen.getByLabelText<HTMLInputElement>('Email');
    expect(input).toHaveAttribute('type', 'password');
    await user.click(input);
    expect(input).toHaveAttribute('type', 'email');
    await user.type(input, 'persn@example.com');
    expect(input).toHaveAttribute('type', 'email');
    await user.tab();
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveValue('persn@example.com');
  });
});

describe('private text', () => {
  it('blurs a stand-in, never the value, and is its own switch', async () => {
    const user = userEvent.setup();
    const { container } = render(<EmailForm />);
    expect(container.innerHTML).not.toContain('saved@example.com');
    // Hidden, the name says what a click does; aria-pressed on top of a
    // label like that announced "..., pressed".
    const show = screen.getByRole('button', { name: 'Show personal info' });
    expect(show).not.toHaveAttribute('aria-pressed');
    expect(show.querySelector('.private-text-mask')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
    await user.click(show);
    // Shown, the name is the value and the action is the description.
    const shown = screen.getByRole('button', { name: 'saved@example.com' });
    expect(shown).toHaveAttribute('title', 'Hide personal info');
    expect(shown.querySelector('.private-text-mask')).toBeNull();
    await user.click(shown);
    expect(container.innerHTML).not.toContain('saved@example.com');
  });

  it('keeps the shape of the value and none of its characters', () => {
    const value = 'Pat Q. Doe-Smith <pat.doe@example.co.uk>';
    const standIn = standInFor(value);
    expect(standIn).toHaveLength(value.length);
    expect(standIn).not.toBe(value);
    // Only @, dots and spaces stay where they were.
    const shape = (text: string) => text.replace(/[^@.\s]/gu, 'x');
    expect(shape(standIn)).toBe(shape(value));
    for (const [index, char] of [...value].entries()) {
      if (/[^@.\s]/u.test(char) && /[^\p{L}\p{N}]/u.test(char)) {
        expect(standIn[index], `punctuation "${char}" kept`).not.toBe(char);
      }
    }
    // The same value keeps the same stand-in, so a re-render does not flicker.
    expect(standInFor(value)).toBe(standIn);
  });

  // Review of #1483: punctuation and emoji passed through unchanged, so an
  // account named "___" showed its real name while hidden.
  it('never shows a value with no letters or digits as itself', () => {
    for (const value of ['___', '🙂🙂', '@.', ' ', '-+-']) {
      const standIn = standInFor(value);
      expect(standIn, value).not.toBe(value);
      expect([...standIn], value).toHaveLength([...value].length);
    }
    render(
      <PrivateText value="___" visible={false} onChange={() => undefined} />
    );
    expect(document.body.innerHTML).not.toContain('___');
  });
});
