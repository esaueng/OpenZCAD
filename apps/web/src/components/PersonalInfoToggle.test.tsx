import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { PersonalInfoToggle, PrivateEmailInput } from './PersonalInfoToggle';

function EmailForm() {
  const [visible, setVisible] = useState(false);
  const [email, setEmail] = useState('');
  return (
    <form>
      <PersonalInfoToggle visible={visible} onChange={setVisible} />
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
      screen.getByRole('button', { name: 'Hide personal info' })
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

describe('personal info toggle', () => {
  it('carries its state in the label alone', async () => {
    const user = userEvent.setup();
    render(<EmailForm />);
    // A label that flips between Show and Hide already says the state;
    // aria-pressed on top announced "Hide personal info, pressed".
    const show = screen.getByRole('button', { name: 'Show personal info' });
    expect(show).not.toHaveAttribute('aria-pressed');
    await user.click(show);
    expect(
      screen.getByRole('button', { name: 'Hide personal info' })
    ).not.toHaveAttribute('aria-pressed');
  });
});
