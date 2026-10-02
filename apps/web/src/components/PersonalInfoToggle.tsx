import { Eye, EyeOff } from 'lucide-react';
import type { InputHTMLAttributes } from 'react';

export function PersonalInfoToggle({
  visible,
  onChange
}: {
  visible: boolean;
  onChange(visible: boolean): void;
}) {
  return (
    <button
      type="button"
      className="secondary"
      aria-pressed={visible}
      onClick={() => onChange(!visible)}
    >
      {visible ? (
        <EyeOff size={14} aria-hidden="true" />
      ) : (
        <Eye size={14} aria-hidden="true" />
      )}
      {visible ? 'Hide personal info' : 'Show personal info'}
    </button>
  );
}

export function PrivateEmailInput({
  visible,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  visible: boolean;
}) {
  return (
    <input
      {...props}
      type={visible ? 'email' : 'password'}
      ref={(input) => {
        if (!input) return;
        // Password masking must preserve the browser's email validation.
        const email = document.createElement('input');
        email.type = 'email';
        email.value = input.value;
        input.setCustomValidity(
          email.validity.valid ? '' : 'Enter a valid email address.'
        );
      }}
    />
  );
}
