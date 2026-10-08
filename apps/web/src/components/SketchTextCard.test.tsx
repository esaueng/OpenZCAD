/**
 * The text card composes before anything is placed: the string field takes
 * the keyboard the moment the card opens, Place stays disabled while there is
 * nothing to place, and Enter in a field is never a placement.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_DOCUMENT_TEXT_OBJECTS,
  MAX_SKETCH_TEXT_OBJECTS,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';

const EMPTY_DOCUMENT = { nodes: {} } as Pick<
  ProjectDocument,
  'nodes' | 'editHistory'
>;

/** `count` one-letter text objects, `perSketch` to a sketch. */
function documentWithText(
  count: number,
  perSketch = MAX_SKETCH_TEXT_OBJECTS
): Pick<ProjectDocument, 'nodes' | 'editHistory'> {
  const nodes: Record<string, unknown> = {};
  for (let sketch = 0; sketch * perSketch < count; sketch += 1) {
    const objectIds: string[] = [];
    for (
      let index = sketch * perSketch;
      index < Math.min(count, (sketch + 1) * perSketch);
      index += 1
    ) {
      nodes[`text_${index}`] = {
        kind: 'sketch-object',
        data: { objectKind: 'text', text: 'x' }
      };
      objectIds.push(`text_${index}`);
    }
    nodes[`node_sketch_${sketch}`] = {
      kind: 'sketch',
      sketchId: `sketch_${sketch}`,
      objectIds
    };
  }
  return { nodes } as unknown as Pick<ProjectDocument, 'nodes' | 'editHistory'>;
}
import { SketchTextCard } from './SketchTextCard';
import {
  newSketchTextDraft,
  type SketchTextDraft
} from '../lib/interaction/machine';

function Harness({
  onPlace = vi.fn(),
  onCancel = vi.fn(),
  document = EMPTY_DOCUMENT,
  sketchId = null,
  anchor = null,
  initial = newSketchTextDraft()
}: {
  onPlace?: (object: SketchObjectData) => void;
  onCancel?: () => void;
  document?: Pick<ProjectDocument, 'nodes' | 'editHistory'>;
  sketchId?: string | null;
  anchor?: { x: number; y: number } | null;
  initial?: SketchTextDraft;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <>
      <SketchTextCard
        draft={draft}
        scope={{ h: 4 }}
        document={document}
        sketchId={sketchId}
        anchorRef={{ current: anchor }}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        onPlace={onPlace}
        onCancel={onCancel}
      />
      <output data-testid="draft">{JSON.stringify(draft)}</output>
    </>
  );
}

const draftOf = (): SketchTextDraft =>
  JSON.parse(
    screen.getByTestId('draft').textContent ?? '{}'
  ) as SketchTextDraft;

describe('SketchTextCard', () => {
  it('focuses the string field on open and keeps Place disabled while empty', () => {
    render(<Harness />);
    const text = screen.getByLabelText('Text');
    expect(document.activeElement).toBe(text);
    expect(screen.getByRole('button', { name: 'Place' })).toBeDisabled();
    expect(screen.getByText('Type the text to place.')).toBeTruthy();
  });

  it('enables Place once there is text, and places it where the outline is', async () => {
    const user = userEvent.setup();
    const onPlace = vi.fn();
    render(<Harness onPlace={onPlace} anchor={{ x: 12, y: -3 }} />);
    await user.type(screen.getByLabelText('Text'), 'Boa');
    expect(draftOf().text).toBe('Boa');
    const place = screen.getByRole('button', { name: 'Place' });
    expect(place).toBeEnabled();
    expect(
      screen.getByText('Click the sketch plane to place it.')
    ).toBeTruthy();
    await user.click(place);
    expect(onPlace).toHaveBeenCalledWith({
      objectKind: 'text',
      text: 'Boa',
      fontFamily: 'open-sans',
      fontStyle: 'regular',
      size: 10,
      x: 12,
      y: -3
    });
  });

  it('places at the sketch origin before the pointer reaches the plane', async () => {
    const user = userEvent.setup();
    const onPlace = vi.fn();
    render(<Harness onPlace={onPlace} />);
    await user.type(screen.getByLabelText('Text'), 'A');
    await user.click(screen.getByRole('button', { name: 'Place' }));
    expect(onPlace).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'A', x: 0, y: 0 })
    );
  });

  it('never places on Enter: placement is the click', async () => {
    const user = userEvent.setup();
    const onPlace = vi.fn();
    render(<Harness onPlace={onPlace} />);
    await user.type(screen.getByLabelText('Text'), 'Boa{Enter}');
    expect(onPlace).not.toHaveBeenCalled();
    expect(draftOf().text).toBe('Boa');
  });

  it('labels the size as the em size and only takes sizes that resolve', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...newSketchTextDraft(), text: 'Boa' }} />);
    const size = screen.getByLabelText('Size (em)');
    await user.clear(size);
    await user.type(size, 'h * 2');
    expect(draftOf().size).toBe('h * 2');
    expect(screen.getByRole('button', { name: 'Place' })).toBeEnabled();
    await user.clear(size);
    await user.type(size, '0');
    // A size that does not resolve to a positive length is what the draft
    // holds, and the shared rule refuses placement with the reason shown.
    expect(draftOf().size).toBe(0);
    expect(screen.getByRole('button', { name: 'Place' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Size must resolve to a number greater than zero.'
    );
  });

  it('sets the family, style and alignment on the draft', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Font'), {
      target: { value: 'lora' }
    });
    await user.click(screen.getByRole('button', { name: 'Bold' }));
    await user.click(screen.getByRole('radio', { name: 'Align center' }));
    expect(draftOf()).toMatchObject({
      fontFamily: 'lora',
      fontStyle: 'bold',
      align: 'center'
    });
    expect(screen.getByRole('radio', { name: 'Align center' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('refuses a string the sketch text budget would drop', () => {
    // The active sketch already holds as many text objects as it may draw.
    render(
      <Harness
        initial={{ ...newSketchTextDraft(), text: 'Boa' }}
        document={documentWithText(MAX_SKETCH_TEXT_OBJECTS)}
        sketchId="sketch_0"
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Sketch text exceeds the outline limit'
    );
    expect(screen.getByRole('button', { name: 'Place' })).toBeDisabled();
  });

  it('refuses at the document limit, where the document itself is still fine', () => {
    render(
      <Harness
        initial={{ ...newSketchTextDraft(), text: 'Boa' }}
        document={documentWithText(MAX_DOCUMENT_TEXT_OBJECTS)}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Project text exceeds the outline limit'
    );
    expect(screen.getByRole('button', { name: 'Place' })).toBeDisabled();
  });

  it('cancels from the close button and the Cancel button', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Cancel text' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
