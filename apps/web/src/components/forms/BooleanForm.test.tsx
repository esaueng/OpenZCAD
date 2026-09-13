import { renderToStaticMarkup } from 'react-dom/server';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toBodyId } from '@openzcad/shared';
import { BooleanForm, type BodyOption } from './FeatureForms';

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

    expect(
      screen.getByRole('button', { name: /Left/ }).className
    ).toContain('selected');
    fireEvent.click(screen.getByRole('button', { name: /Right/ }));
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: /Right/ }).className
    ).toContain('selected');
  });
});
