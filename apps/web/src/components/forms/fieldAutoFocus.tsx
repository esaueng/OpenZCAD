import { createContext, useContext, type ReactNode } from 'react';

/**
 * Whether a form on screen may take the keyboard on mount.
 *
 * The same form components serve two different intents. A CREATE dialog is on
 * screen because the user invoked the tool, so landing in the first field —
 * with its value selected, ready to be replaced — is the next thing they meant
 * to do. An EDIT panel is on screen because they selected something, and
 * nobody asked to type: taking the keyboard there swallows the workspace's own
 * single-letter shortcuts, and because focus also selects the value, the first
 * letter REPLACES the dimension instead of appending to it. `M` on a selected
 * body left Width reading "m"; `w` then `f` made it "mwf", and no tool ran.
 *
 * Only the panel host knows which intent it is rendering, so the rule lives
 * there and travels by context — the alternative was an identical prop
 * threaded through eight form components to reach nine fields. It is
 * deliberately NOT derived from the submit label: that is display text, and it
 * would silently invert the day someone rewords a button.
 *
 * Defaults to true so any form outside a panel keeps the behaviour it had.
 */
const FieldAutoFocusContext = createContext(true);

export function FieldAutoFocusProvider({
  allowed,
  children
}: {
  allowed: boolean;
  children: ReactNode;
}) {
  return (
    <FieldAutoFocusContext.Provider value={allowed}>
      {children}
    </FieldAutoFocusContext.Provider>
  );
}

/** True when a field marked `autoFocus` should actually take the keyboard. */
export function useFieldAutoFocus(requested: boolean | undefined): boolean {
  return useContext(FieldAutoFocusContext) && requested === true;
}
