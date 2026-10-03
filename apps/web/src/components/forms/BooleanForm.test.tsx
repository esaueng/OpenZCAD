import { renderToStaticMarkup } from 'react-dom/server';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toBodyId } from '@openzcad/shared';
import {
  BooleanForm,
  distinctBodyNames,
  type BodyOption
} from './FeatureForms';

const bodies: BodyOption[] = [
  { bodyId: toBodyId('body_left'), name: 'Left', consumed: false },
  { bodyId: toBodyId('body_right'), name: 'Right', consumed: false }
];

describe('Boolean form guidance', () => {
  it('explains that Union cannot fill a gap', () => {
    const markup = renderToStaticMarkup(
      <BooleanForm
        bodies={bodies}
        presetOperation="union"
        submitLabel="Create"
        onSubmit={() => undefined}
      />
    );

    expect(markup).toContain(
      'Union joins solids that touch or overlap. It does not fill empty gaps.'
    );
  });
});

describe('Boolean form pick list', () => {
  it('is a view of the viewport selection, reporting toggles in pick order', () => {
    const onSelectionChange = vi.fn();
    const { rerender } = render(
      <BooleanForm
        bodies={bodies}
        presetOperation="subtract"
        selection={[bodies[1]!.bodyId]}
        onSelectionChange={onSelectionChange}
        submitLabel="Create"
        onSubmit={() => undefined}
      />
    );

    // The body picked in the scene is already row 1, the subtract base.
    const right = screen.getByRole('button', { name: /Right/ });
    expect(right.className).toContain('selected');
    expect(right.textContent).toContain('1');
    expect(right.textContent).toContain('base');

    fireEvent.click(screen.getByRole('button', { name: /Left/ }));
    expect(onSelectionChange).toHaveBeenCalledWith([
      bodies[1]!.bodyId,
      bodies[0]!.bodyId
    ]);

    // The list follows the viewport, not its own memory: a body clicked in
    // the scene appears here with the next number.
    rerender(
      <BooleanForm
        bodies={bodies}
        presetOperation="subtract"
        selection={[bodies[1]!.bodyId, bodies[0]!.bodyId]}
        onSelectionChange={onSelectionChange}
        submitLabel="Create"
        onSubmit={() => undefined}
      />
    );
    const left = screen.getByRole('button', { name: /Left/ });
    expect(left.className).toContain('selected');
    expect(left.textContent).toContain('2');

    fireEvent.click(left);
    expect(onSelectionChange).toHaveBeenLastCalledWith([bodies[1]!.bodyId]);
  });

  it('keeps its own list while editing an existing feature', () => {
    const onSelectionChange = vi.fn();
    render(
      <BooleanForm
        bodies={bodies}
        initial={{
          name: 'Union',
          operation: 'union',
          targetBodyIds: [bodies[0]!.bodyId]
        }}
        selection={[bodies[1]!.bodyId]}
        onSelectionChange={onSelectionChange}
        submitLabel="Apply"
        onSubmit={() => undefined}
      />
    );

    expect(screen.getByRole('button', { name: /Left/ }).className).toContain(
      'selected'
    );
    fireEvent.click(screen.getByRole('button', { name: /Right/ }));
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Right/ }).className).toContain(
      'selected'
    );
  });
});

describe('Boolean form Enter key', () => {
  it('creates from a focused pick-list row instead of toggling it', () => {
    const onSubmit = vi.fn();
    render(
      <BooleanForm
        bodies={bodies}
        presetOperation="union"
        submitLabel="Create"
        onSubmit={onSubmit}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Left/ }));
    const right = screen.getByRole('button', { name: /Right/ });
    fireEvent.click(right);
    right.focus();
    expect(right.getAttribute('aria-pressed')).toBe('true');

    // The browser would activate the focused row on Enter and un-pick it;
    // the form claims the key and creates instead.
    const notCancelled = fireEvent.keyDown(right, { key: 'Enter' });
    expect(notCancelled).toBe(false);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'union',
        targetBodyIds: [bodies[0]!.bodyId, bodies[1]!.bodyId]
      })
    );
    expect(right.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Boolean form pick rows', () => {
  it('names each row by its body, then its pick order', () => {
    render(
      <BooleanForm
        bodies={bodies}
        presetOperation="subtract"
        selection={[bodies[1]!.bodyId]}
        submitLabel="Create"
        onSubmit={() => undefined}
      />
    );
    // The badge alone is a bare digit (or nothing), which read as an
    // unnamed row; the name leads, and the order and base follow.
    expect(
      screen.getByRole('button', { name: 'Right, pick 1, base' })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Left' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });
});

describe('Boolean form body names', () => {
  it('tells two bodies of one stored name apart, by name and by role', () => {
    // A document made before bodies were numbered: two "Box Body" rows.
    const twins: BodyOption[] = [
      { bodyId: toBodyId('body_a'), name: 'Box Body', consumed: false },
      { bodyId: toBodyId('body_b'), name: 'Box Body', consumed: false },
      { bodyId: toBodyId('body_c'), name: 'Cylinder Body', consumed: false }
    ];
    const { container, rerender } = render(
      <BooleanForm
        bodies={twins}
        presetOperation="subtract"
        selection={[twins[1]!.bodyId]}
        submitLabel="Create"
        onSubmit={() => undefined}
      />
    );
    expect(
      [...container.querySelectorAll('.pick-row .body-name')].map(
        (name) => name.textContent
      )
    ).toEqual(['Box Body (1)', 'Box Body (2)', 'Cylinder Body']);
    expect(
      screen.getByRole('button', { name: 'Box Body (2), pick 1, base' })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: 'Box Body (1)' })
    ).toHaveAttribute('aria-pressed', 'false');
    rerender(
      <BooleanForm
        bodies={twins}
        presetOperation="subtract"
        selection={[twins[1]!.bodyId, twins[0]!.bodyId]}
        submitLabel="Create"
        onSubmit={() => undefined}
      />
    );
    expect(
      screen.getByRole('button', { name: 'Box Body (1), pick 2' })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(twins.map((body) => body.name)).toEqual([
      'Box Body',
      'Box Body',
      'Cylinder Body'
    ]);
  });

  it('leaves distinct names exactly as stored', () => {
    expect([
      ...distinctBodyNames([
        { bodyId: toBodyId('body_a'), name: 'Box 1' },
        { bodyId: toBodyId('body_b'), name: 'Box 2' }
      ]).values()
    ]).toEqual(['Box 1', 'Box 2']);
  });

  it('keeps duplicate labels distinct from a stored ordinal name', () => {
    expect([
      ...distinctBodyNames([
        { bodyId: toBodyId('body_a'), name: 'Box Body' },
        { bodyId: toBodyId('body_b'), name: 'Box Body' },
        { bodyId: toBodyId('body_c'), name: 'Box Body (1)' }
      ]).values()
    ]).toEqual(['Box Body (2)', 'Box Body (3)', 'Box Body (1)']);
  });
});
