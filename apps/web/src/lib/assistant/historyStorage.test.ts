import { afterEach, expect, it, vi } from 'vitest';
import {
  ASSISTANT_HISTORY_CLEARED_EVENT,
  ASSISTANT_HISTORY_STORAGE_KEY,
  clearAssistantHistory
} from './historyStorage';

afterEach(() => vi.restoreAllMocks());

it('removes persisted history and notifies in-memory listeners', () => {
  localStorage.setItem(ASSISTANT_HISTORY_STORAGE_KEY, 'private history');
  const cleared = vi.fn();
  window.addEventListener(ASSISTANT_HISTORY_CLEARED_EVENT, cleared, {
    once: true
  });
  clearAssistantHistory();
  expect(localStorage.getItem(ASSISTANT_HISTORY_STORAGE_KEY)).toBeNull();
  expect(cleared).toHaveBeenCalledOnce();
});

it.each(['access', 'remove'])(
  'continues cleanup when storage %s throws',
  (failure) => {
    const denied = () => {
      throw new DOMException('Storage disabled', 'SecurityError');
    };
    if (failure === 'access')
      vi.spyOn(window, 'localStorage', 'get').mockImplementation(denied);
    else vi.spyOn(window.localStorage, 'removeItem').mockImplementation(denied);
    const cleared = vi.fn();
    window.addEventListener(ASSISTANT_HISTORY_CLEARED_EVENT, cleared, {
      once: true
    });
    expect(() => clearAssistantHistory()).not.toThrow();
    expect(cleared).toHaveBeenCalledOnce();
  }
);
