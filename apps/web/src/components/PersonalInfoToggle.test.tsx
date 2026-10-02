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
