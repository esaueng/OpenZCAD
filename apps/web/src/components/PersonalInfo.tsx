import {
  useState,
  useSyncExternalStore,
  type InputHTMLAttributes
} from 'react';

// Clicking any hidden name or email flips this one switch: Settings, project
// sharing and the cloud deletion dialog all follow it. Memory only, so every page load starts hidden
// for screenshots.
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

// A stand-in for each hidden value, made once per value and page load: the
// same shape (length, @, dots and spaces), none of the characters, so a
// blurred screenshot cannot be sharpened back into the real text. Only those
// separators survive; every other character, punctuation and emoji included,
// is replaced, so a name like "___" or "🙂" is not shown as itself.
const standIns = new Map<string, string>();
const LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const KEPT = /^[@.\s]$/u;

function pick(alphabet: string) {
  return alphabet[Math.floor(Math.random() * alphabet.length)]!;
}

function scramble(value: string, keepSeparators: boolean) {
  return Array.from(value, (char) =>
    keepSeparators && KEPT.test(char)
      ? char
      : /\p{Lu}/u.test(char)
        ? pick(UPPER)
        : pick(LOWER)
  ).join('');
}

export function standInFor(value: string) {
  let standIn = standIns.get(value);
  if (standIn === undefined) {
    standIn = scramble(value, true);
    // Nothing but separators ("@.", " ") would come back as itself, and any
    // stand-in that happens to spell the value would show it.
    while (standIn === value && value.length > 0) {
      standIn = scramble(value, false);
    }
    standIns.set(value, standIn);
  }
  return standIn;
}

/**
 * A name or email shown in place, blurred until clicked. The hidden form
 * renders a scrambled stand-in, never the value, so neither the page source
 * nor a screenshot carries it; a second click hides it again. There is no
 * separate show/hide button: the value is its own switch.
 */
export function PrivateText({
  value,
  visible,
  onChange,
  className
}: {
  value: string;
  visible: boolean;
  onChange(visible: boolean): void;
  className?: string;
}) {
  // Hidden, the name says what a click does. Shown, the name is the value
  // itself and the action moves to the description, so a screen reader reads
  // the address rather than a label about it.
  return (
    <button
      type="button"
      className={`private-text${visible ? ' shown' : ''}${className ? ` ${className}` : ''}`}
      aria-label={visible ? undefined : 'Show personal info'}
      title={visible ? 'Hide personal info' : 'Show personal info'}
      onClick={() => onChange(!visible)}
    >
      {visible ? (
        value
      ) : (
        <span className="private-text-mask" aria-hidden="true">
          {standInFor(value)}
        </span>
      )}
    </button>
  );
}

/**
 * An email field masked for screenshots, but only while it is not being
 * typed in: a masked field hid typos from the person typing (design review
 * I78). Focused, it shows what was typed; on blur it masks again.
 */
export function PrivateEmailInput({
  visible,
  onFocus,
  onBlur,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  visible: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      {...props}
      type={visible || focused ? 'email' : 'password'}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
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
