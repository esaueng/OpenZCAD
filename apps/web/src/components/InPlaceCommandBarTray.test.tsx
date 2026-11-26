import { fireEvent, render, screen, within } from '@testing-library/react';
import { Box } from 'lucide-react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPACT_SHEET_RAISE_EVENT,
  CompactCommandTrayContext
} from './compact/compactSlots';
import { InPlaceCommandBar } from './InPlaceCommandBar';
import { MoveOverlay } from './MoveOverlay';

/** Drawn in the compact sheet, as WorkspaceReadout portals it there. */
function inTray(children: ReactNode) {
  return (
    <CompactCommandTrayContext.Provider value={true}>
      {children}
    </CompactCommandTrayContext.Provider>
  );
}

/** The words drawn on screen: text nodes outside visually hidden spans. */
function visibleWords(element: HTMLElement): string[] {
  const words: string[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('.visually-hidden')) continue;
    words.push(...(node.textContent ?? '').split(/\s+/).filter(Boolean));
  }
  return words;
}

function raises(element: HTMLElement) {
  const seen: string[] = [];
  element.ownerDocument.addEventListener(COMPACT_SHEET_RAISE_EVENT, (event) =>
    seen.push((event as CustomEvent<string>).detail)
  );
  return seen;
}

const OPTION = {
  id: 'anchor',
  label: 'Anchor',
  value: 'centre',
  choices: [
    { value: 'centre', label: 'Centre' },
    { value: 'corner', label: 'Corner' }
  ]
};

describe('an in-place command drawn as the compact tray (U12 slice 4)', () => {
  it('pins one row of its icon, step, Options, Cancel and Done, keeping every name', () => {
    const onDone = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      inTray(
        <InPlaceCommandBar
          title="Box"
          icon={<Box size={16} aria-hidden="true" />}
          hint="Drag the arrows, or tap a size to type"
          canFinish
          options={[OPTION]}
          onDone={onDone}
          onCancel={onCancel}
        />
      )
    );
    const bar = screen.getByRole('group', { name: 'Box command' });
    expect(bar).toHaveClass('is-tray');
    const row = container.querySelector<HTMLElement>('.compact-tray-row')!;
    expect(bar.firstElementChild).toBe(row);
    // At most four words: the step and Done.
    expect(visibleWords(row)).toEqual(['Arrows', 'Done']);
    const names = within(row)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(names).toEqual(['Box options', 'Cancel', 'Done']);
    // The full step is still the bar's status, for assistive technology.
    expect(screen.getByRole('status')).toHaveTextContent(
      'Drag the arrows, or tap a size to type'
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(within(row).getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
    // One control per name: the disclosure's own summary is out of reach.
    expect(screen.getAllByLabelText('Box options')).toHaveLength(1);
  });

  it('opens its Options in the flow under the row and asks the sheet for room', () => {
    render(
      inTray(
        <InPlaceCommandBar
          title="Box"
          hint="Drag the arrows"
          canFinish
          options={[OPTION]}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    );
    const bar = screen.getByRole('group', { name: 'Box command' });
    const seen = raises(bar);
    const toggle = screen.getByRole('button', { name: 'Box options' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const details = bar.querySelector('details')!;
    expect(details.open).toBe(true);
    fireEvent(details, new Event('toggle'));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(seen).toContain('half');
    expect(
      screen.getByRole('radiogroup', { name: 'Anchor' })
    ).toBeInTheDocument();
  });

  it('says a refusal in its chip and in full under the row, raising the sheet', () => {
    const seen: string[] = [];
    document.addEventListener(COMPACT_SHEET_RAISE_EVENT, (event) =>
      seen.push((event as CustomEvent<string>).detail)
    );
    const { container } = render(
      inTray(
        <InPlaceCommandBar
          title="Fillet"
          hint="1 edge · drag the radius"
          refusal="The fillet radius is too large for these edges."
          canFinish={false}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    );
    expect(container.querySelector('.compact-step-chip')).toHaveTextContent(
      'Needs attention'
    );
    expect(screen.getByRole('status')).toHaveTextContent(/too large/);
    expect(seen).toContain('half');
  });

  it('leaves the bar as it was on the regular stage', () => {
    const { container } = render(
      <InPlaceCommandBar
        title="Box"
        hint="Drag the arrows"
        canFinish
        options={[OPTION]}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(container.querySelector('.compact-tray-row')).toBeNull();
    expect(container.querySelector('.is-tray')).toBeNull();
    expect(
      container.querySelector('summary[aria-label="Box options"]')
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: /Cancel/ })).toHaveTextContent(
      'CancelEsc'
    );
  });
});

describe('Move drawn as the compact tray', () => {
  it('pins its step, Options, Cancel and Done in one row', () => {
    const onConfirm = vi.fn();
    const { container } = render(
      inTray(
        <MoveOverlay
          bodyName="Box 1"
          values={{
            translation: { x: 5, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }}
          units="mm"
          snap={null}
          onChange={vi.fn()}
          onConfirm={onConfirm}
          onCancel={vi.fn()}
        />
      )
    );
    const row = container.querySelector<HTMLElement>('.compact-tray-row')!;
    expect(visibleWords(row)).toEqual(['Drag', 'Done']);
    expect(
      within(row)
        .getAllByRole('button')
        .map(
          (button) => button.getAttribute('aria-label') ?? button.textContent
        )
    ).toEqual(['Move options', 'Cancel', 'Done']);
    fireEvent.click(within(row).getByRole('button', { name: 'Done' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
