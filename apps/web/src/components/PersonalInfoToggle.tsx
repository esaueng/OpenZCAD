import { Eye, EyeOff } from 'lucide-react';
import { useSyncExternalStore, type InputHTMLAttributes } from 'react';

// Settings owns the only switch; project sharing follows it. Memory only, so
// every page load starts hidden for screenshots.
let personalInfoVisible = false;
const listeners = new Set<() => void>();

export function setPersonalInfoVisible(visible: boolean) {
  if (visible === personalInfoVisible) return;
  personalInfoVisible = visible;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePersonalInfoVisible() {
  return useSyncExternalStore(
    subscribe,
    () => personalInfoVisible,
    () => false
  );
}

export function PersonalInfoToggle({
  visible,
  onChange
}: {
  visible: boolean;
  onChange(visible: boolean): void;
}) {
  // The label names the action and so already carries the state. Adding
  // aria-pressed on top announced "Hide personal info, pressed": a toggle
  // button's label has to stay put, and this one deliberately does not.
  return (
    <button
      type="button"
      className="secondary"
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
