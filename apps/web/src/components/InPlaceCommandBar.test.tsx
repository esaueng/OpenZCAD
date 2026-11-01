import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InPlaceCommandBar } from './InPlaceCommandBar';

describe('InPlaceCommandBar', () => {
  it('explains a body-removing cut and preserves its diagnostic behind details', () => {
    const diagnostic = 'Empty result: cut target fully contained in tool';
    render(
      <InPlaceCommandBar
        title="Hole"
        hint="Drag the diameter"
        refusal={diagnostic}
        canFinish={false}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByRole('status').textContent).toContain(
      'This cut would remove the entire target body'
    );
    const disclosure = screen.getByText('Technical details').closest('details');
    expect(disclosure).toHaveProperty('open', false);
    expect(disclosure?.textContent).toContain(diagnostic);
  });

  it('offers the rest of a refusal too long for its three lines', () => {
    // F014: an oversized fillet's "Try a smaller radius: radius 11.8 builds
    // here." sat past the one-line ellipsis, reachable only by tooltip.
    const refusal =
      'Feature "Fillet": Fillet could not be created on 1 selected edge with radius 1000. Try a smaller radius: radius 11.8 builds here.';
    const scrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight'
    );
    const clientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientHeight'
    );
    // Laid out, the clamped hint holds 3 of its 4 lines.
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 64;
      }
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return 48;
      }
    });
    try {
      render(
        <InPlaceCommandBar
          title="Fillet"
          hint="Drag the radius"
          refusal={refusal}
          canFinish={false}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      );
      const status = screen.getByRole('status');
      expect(status.textContent).toBe(refusal);
      const more = screen.getByRole('button', { name: 'More' });
      expect(more).toHaveAttribute('aria-expanded', 'false');
      expect(more).toHaveAttribute('aria-controls', status.id);
      fireEvent.click(more);
      expect(status).toHaveClass('is-expanded');
      expect(screen.getByRole('button', { name: 'Less' })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
    } finally {
      for (const [name, descriptor] of [
        ['scrollHeight', scrollHeight],
        ['clientHeight', clientHeight]
      ] as const) {
        if (descriptor) {
          Object.defineProperty(HTMLElement.prototype, name, descriptor);
        } else {
          Reflect.deleteProperty(HTMLElement.prototype, name);
        }
      }
    }
  });

  it('shows no More while the refusal fits, nor for a plain hint', () => {
    const { rerender } = render(
      <InPlaceCommandBar
        title="Fillet"
        hint="Drag the radius"
        refusal="Radius must be positive."
        canFinish={false}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    rerender(
      <InPlaceCommandBar
        title="Fillet"
        hint="Drag the radius"
        canFinish={false}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('offers precise values before Done without committing', () => {
    const precise = vi.fn();
    const done = vi.fn();
    render(
      <InPlaceCommandBar
        title="Hole"
        hint="Drag the diameter"
        canFinish
        onPreciseValues={precise}
        onDone={done}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Precise values…' }));
    expect(precise).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
  });
  it('names the command and its step, with no fields', () => {
    render(
      <InPlaceCommandBar
        title="Revolve"
        hint="Pick the axis to turn around"
        canFinish={false}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const bar = screen.getByRole('group', { name: 'Revolve command' });
    expect(bar.textContent).toContain('Pick the axis to turn around');
    expect(bar.querySelector('input, select, textarea')).toBeNull();
  });

  it('holds Done until the command can finish', () => {
    const onDone = vi.fn();
    const { rerender } = render(
      <InPlaceCommandBar
        title="Revolve"
        hint="Drag the angle"
        canFinish={false}
        onDone={onDone}
        onCancel={vi.fn()}
      />
    );
    const done = screen.getByRole('button', { name: /Done/ });
    expect(done).toHaveProperty('disabled', true);
    rerender(
      <InPlaceCommandBar
        title="Revolve"
        hint="Drag the angle"
        canFinish
        onDone={onDone}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Done/ }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('takes nothing but Cancel while locked', () => {
    const onOption = vi.fn();
    const onValue = vi.fn();
    const onAction = vi.fn();
    const onCancel = vi.fn();
    render(
      <InPlaceCommandBar
        title="Extrude"
        hint="Checking"
        canFinish
        locked
        options={[
          {
            id: 'operation',
            label: 'Operation',
            value: 'automatic',
            choices: [
              { value: 'automatic', label: 'Automatic' },
              { value: 'cut', label: 'Cut' }
            ]
          }
        ]}
        onOption={onOption}
        values={[{ id: 'distance', label: 'Distance', text: '10 mm' }]}
        onValue={onValue}
        actions={[{ id: 'reverse', label: 'Reverse direction' }]}
        onAction={onAction}
        onDone={vi.fn()}
        onCancel={onCancel}
      />
    );
    for (const name of ['Cut', 'Distance', 'Reverse direction', 'Done']) {
      const control = screen.getByRole(name === 'Cut' ? 'radio' : 'button', {
        name: new RegExp(name),
        hidden: true
      });
      expect(control).toHaveProperty('disabled', true);
      fireEvent.click(control);
    }
    expect(onOption).not.toHaveBeenCalled();
    expect(onValue).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows a refusal in place of the hint and still cancels', () => {
    const onCancel = vi.fn();
    render(
      <InPlaceCommandBar
        title="Revolve"
        hint="Drag the angle"
        refusal="This revolve did not produce a valid body."
        canFinish={false}
        onDone={vi.fn()}
        onCancel={onCancel}
      />
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toBe(
      'This revolve did not produce a valid body.'
    );
    expect(status.closest('.in-place-command')?.className).toContain('refused');
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('offers rare choices behind Options and reports a pick', () => {
    const onOption = vi.fn();
    render(
      <InPlaceCommandBar
        title="Hole"
        hint="Drag the diameter"
        canFinish
        options={[
          {
            id: 'depthMode',
            label: 'Depth',
            value: 'through',
            choices: [
              { value: 'through', label: 'Through all' },
              { value: 'blind', label: 'Blind' }
            ]
          }
        ]}
        onOption={onOption}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const group = screen.getByRole('radiogroup', { name: 'Depth' });
    expect(
      screen
        .getByRole('radio', { name: 'Through all' })
        .getAttribute('aria-checked')
    ).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Blind' }));
    expect(onOption).toHaveBeenCalledWith('depthMode', 'blind');
    expect(group).toBeTruthy();
  });
  it('explains the chosen choice where the card did', () => {
    const options = (value: string) => [
      {
        id: 'mode',
        label: 'Mode',
        value,
        choices: [
          { value: 'standard', label: 'Standard' },
          { value: 'smooth', label: 'Smooth', note: 'Not exact surfaces.' }
        ]
      }
    ];
    const { rerender } = render(
      <InPlaceCommandBar
        title="Sweep"
        hint="Pick the path"
        canFinish={false}
        options={options('standard')}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByText('Not exact surfaces.')).toBeNull();
    rerender(
      <InPlaceCommandBar
        title="Sweep"
        hint="Pick the path"
        canFinish={false}
        options={options('smooth')}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText('Not exact surfaces.')).toBeTruthy();
  });

  it('puts exact numbers behind Options, each opening entry where it sits', () => {
    const onValue = vi.fn();
    render(
      <InPlaceCommandBar
        title="Box"
        hint="Drag a footprint"
        canFinish
        values={[
          { id: 'x', label: 'Corner X', text: '0 mm' },
          { id: 'y', label: 'Corner Y', text: 'gap' }
        ]}
        onValue={onValue}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Corner Y' }).textContent).toBe(
      'gap'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Corner X' }));
    expect(onValue).toHaveBeenCalledWith('x', { x: 0, y: 0 });
  });

  it('names glyph-labelled values in words, keeping the glyph on screen', () => {
    const { unmount } = render(
      <InPlaceCommandBar
        title="Hole"
        hint="Click a flat face"
        canFinish
        values={[
          { id: 'diameter', label: '⌀', text: '6 mm' },
          { id: 'counterboreDiameter', label: 'Counterbore ⌀', text: '10.8 mm' }
        ]}
        onValue={vi.fn()}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Diameter' }).textContent).toBe(
      '6 mm'
    );
    expect(
      screen.getByRole('button', { name: 'Counterbore diameter' })
    ).toBeTruthy();
    // The glyph stays visible beside the value.
    expect(screen.getByText('⌀')).toBeTruthy();
    unmount();

    render(
      <InPlaceCommandBar
        title="Fillet"
        hint="Drag the radius"
        canFinish
        values={[
          { id: 'radius', label: 'R', text: '2', value: 2, step: 0.5, min: 0 }
        ]}
        onValueCommit={vi.fn(() => true)}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByRole('textbox', { name: 'Radius' })).toHaveValue('2');
  });

  it('types a value in place, with its own unit beside it', () => {
    const onValueCommit = vi.fn((_id: string, text: string) => text !== 'x');
    const onCancel = vi.fn();
    render(
      <InPlaceCommandBar
        title="Gear"
        hint="Drag the face width"
        canFinish
        values={[
          {
            id: 'pressureAngleDeg',
            label: 'Pressure angle',
            text: '20',
            suffix: '°',
            value: 20,
            step: 1,
            min: 0,
            max: 45
          }
        ]}
        onValueCommit={onValueCommit}
        onDone={vi.fn()}
        onCancel={onCancel}
      />
    );
    const field = screen.getByRole('textbox', { name: 'Pressure angle' });
    expect(field).toHaveValue('20');
    // The unit is the value's own: an angle reads in degrees, never "mm".
    expect(field.parentElement?.textContent).toBe('°');
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '25' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onValueCommit).toHaveBeenLastCalledWith('pressureAngleDeg', '25');
    // A refused entry is marked and kept for correcting.
    fireEvent.change(field, { target: { value: 'x' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveValue('x');
    // Escape puts the field back without committing or canceling.
    onValueCommit.mockClear();
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.blur(field);
    expect(onValueCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(field).toHaveValue('20');
  });

  it('steps a value with the arrow keys, within its limits', () => {
    const onValueCommit = vi.fn(() => true);
    render(
      <InPlaceCommandBar
        title="Gear"
        hint="Drag the face width"
        canFinish
        values={[
          {
            id: 'teeth',
            label: 'Teeth',
            text: '20',
            value: 20,
            step: 1,
            min: 1,
            max: 21,
            integer: true
          }
        ]}
        onValueCommit={onValueCommit}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const field = screen.getByRole('textbox', { name: 'Teeth' });
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(onValueCommit).toHaveBeenLastCalledWith('teeth', '21');
    // Ten at a time with Shift, held to the maximum.
    fireEvent.keyDown(field, { key: 'ArrowUp', shiftKey: true });
    expect(onValueCommit).toHaveBeenLastCalledWith('teeth', '21');
    fireEvent.keyDown(field, { key: 'ArrowDown', shiftKey: true });
    expect(onValueCommit).toHaveBeenLastCalledWith('teeth', '10');
  });

  it('scrubs a value on its name, previewing until the release', () => {
    const onValueCommit = vi.fn(() => true);
    const onValuePreview = vi.fn();
    render(
      <InPlaceCommandBar
        title="Gear"
        hint="Drag the face width"
        canFinish
        values={[
          {
            id: 'faceWidth',
            label: 'Face width',
            text: '10',
            suffix: 'mm',
            value: 10,
            step: 1,
            min: 0
          }
        ]}
        onValueCommit={onValueCommit}
        onValuePreview={onValuePreview}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const label = screen.getByText('Face width');
    fireEvent.pointerDown(label, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 112 });
    expect(onValuePreview).toHaveBeenLastCalledWith('faceWidth', 13);
    expect(onValueCommit).not.toHaveBeenCalled();
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 20 });
    expect(onValuePreview).toHaveBeenLastCalledWith('faceWidth', 0);
    fireEvent.pointerUp(label, { pointerId: 1, clientX: 20 });
    expect(onValueCommit).toHaveBeenCalledWith('faceWidth', '0');
  });

  it('lays rows out by section, folding the rarely changed away', () => {
    render(
      <InPlaceCommandBar
        title="Gear"
        hint="Drag the face width"
        canFinish
        summary="Module 2 mm · Pitch Ø 40 mm"
        options={[
          {
            id: 'gearType',
            label: 'Gear',
            value: 'external',
            choices: [
              { value: 'external', label: 'External' },
              { value: 'internal', label: 'Internal (ring)' },
              { value: 'rack', label: 'Rack' },
              { value: 'bevel', label: 'Bevel' },
              { value: 'worm', label: 'Worm' },
              { value: 'worm-wheel', label: 'Worm wheel' }
            ]
          }
        ]}
        values={[
          { id: 'teeth', label: 'Teeth', text: '20', value: 20 },
          { id: 'backlash', label: 'Backlash', text: '0', value: 0 },
          { id: 'x', label: 'Corner X', text: '1', value: 1 },
          { id: 'y', label: 'Corner Y', text: '2', value: 2 }
        ]}
        sections={[
          {
            rows: [
              { kind: 'option', id: 'gearType' },
              { kind: 'value', id: 'teeth' },
              {
                kind: 'vector',
                label: 'Corner',
                ids: ['x', 'y'],
                axes: ['X', 'Y']
              }
            ]
          },
          {
            label: 'Tooth form',
            collapsed: true,
            rows: [{ kind: 'value', id: 'backlash' }]
          }
        ]}
        onValueCommit={vi.fn(() => true)}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText('Module 2 mm · Pitch Ø 40 mm')).toBeTruthy();
    // Six or more choices are a menu, not a row of buttons.
    expect(screen.getByRole('combobox', { name: 'Gear' })).toHaveValue(
      'external'
    );
    expect(screen.queryByRole('radiogroup', { name: 'Gear' })).toBeNull();
    // Folded by a button: the bar's Options stay its only summary.
    const fold = screen.getByRole('button', { name: 'Tooth form' });
    const folded = document.getElementById(
      fold.getAttribute('aria-controls')!
    )!;
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(folded.hidden).toBe(true);
    expect(folded.textContent).toContain('Backlash');
    expect(document.querySelectorAll('summary')).toHaveLength(1);
    fireEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(folded.hidden).toBe(false);
    // A point's fields share its row, each named for its axis.
    expect(screen.getByRole('textbox', { name: 'Corner X' })).toHaveValue('1');
    expect(screen.getByRole('textbox', { name: 'Corner Y' })).toHaveValue('2');
    const rows = document.querySelectorAll('.in-place-param-row');
    expect(
      [...rows].map(
        (row) => row.querySelector('.in-place-option-label')?.textContent
      )
    ).toEqual(['Gear', 'Teeth', 'Corner', 'Backlash']);
  });

  it('names Done and Cancel by their verbs, their keys as shortcuts', () => {
    render(
      <InPlaceCommandBar
        title="Box"
        hint="Drag a footprint"
        canFinish
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(
      screen
        .getByRole('button', { name: 'Done' })
        .getAttribute('aria-keyshortcuts')
    ).toBe('Enter');
    expect(
      screen
        .getByRole('button', { name: 'Cancel' })
        .getAttribute('aria-keyshortcuts')
    ).toBe('Escape');
  });
});
