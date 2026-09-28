import { describe, expect, it, vi } from 'vitest';
import { selectionCapabilities } from './interaction/capabilities';
import { LIVE_DIAMETER_ATTRIBUTE } from './liveLabels';
import {
  MAX_SELECTION_VERBS,
  refreshSelectionCallout,
  renderSelectionCallout,
  selectionCalloutVerbs,
  type SelectionCalloutContent
} from './selectionCallout';
import { textLabelSegments } from './topologyLabels';
import type { ToolAvailability } from './tools';

const READY: ToolAvailability = {
  sketchCount: 1,
  closedProfileSketchCount: 1,
  liveBodyCount: 2,
  exactGeometryReady: true,
  hasEdgeSelected: false
};

const planarFace = selectionCapabilities({
  kind: 'face',
  target: {
    surfaceType: 'planar',
    hash: 7
  }
});

describe('selectionCalloutVerbs', () => {
  it('offers a planar face its offset, a sketch and a hole', () => {
    const verbs = selectionCalloutVerbs({
      kind: 'face',
      faceCapabilities: planarFace,
      pressedAction: 'offset-face',
      availability: READY
    });
    expect(verbs.map((verb) => verb.label)).toEqual([
      'Offset',
      'Sketch',
      'Hole'
    ]);
    expect(verbs.map((verb) => verb.id)).toEqual([
      'action:offset-face',
      'action:sketch-on-face',
      'tool:hole'
    ]);
    // The armed operation reads as pressed; the others do not.
    expect(verbs.map((verb) => verb.pressed)).toEqual([true, false, false]);
  });

  it('falls back to the tools when the machine does not hold the face', () => {
    const verbs = selectionCalloutVerbs({
      kind: 'face',
      faceCapabilities: null,
      availability: READY
    });
    expect(verbs.map((verb) => verb.id)).toEqual(['tool:sketch', 'tool:hole']);
  });

  it('switches the armed edge op, or launches the tool when none is armed', () => {
    const armed = selectionCalloutVerbs({
      kind: 'edges',
      edgesArmed: true,
      pressedAction: 'fillet',
      availability: READY
    });
    expect(armed.map((verb) => [verb.id, verb.pressed])).toEqual([
      ['action:fillet', true],
      ['action:chamfer', false]
    ]);
    const unarmed = selectionCalloutVerbs({
      kind: 'edges',
      availability: READY
    });
    expect(unarmed.map((verb) => verb.id)).toEqual([
      'tool:fillet',
      'tool:chamfer'
    ]);
  });

  it('offers a body Move and Mirror, and several bodies Union first', () => {
    expect(
      selectionCalloutVerbs({ kind: 'body', availability: READY }).map(
        (verb) => verb.label
      )
    ).toEqual(['Move', 'Mirror']);
    expect(
      selectionCalloutVerbs({ kind: 'bodies', availability: READY }).map(
        (verb) => verb.label
      )
    ).toEqual(['Union', 'Move', 'Mirror']);
  });

  it('disables a tool verb with the reason it cannot run', () => {
    const [union] = selectionCalloutVerbs({
      kind: 'bodies',
      availability: { ...READY, liveBodyCount: 1 }
    });
    expect(union?.disabled).toBe(true);
    expect(union?.title).toContain('Needs at least two bodies');
  });

  it('never offers more than three verbs', () => {
    for (const kind of ['face', 'edges', 'body', 'bodies'] as const) {
      expect(
        selectionCalloutVerbs({
          kind,
          faceCapabilities: planarFace,
          availability: READY
        }).length
      ).toBeLessThanOrEqual(MAX_SELECTION_VERBS);
    }
  });
});

describe('renderSelectionCallout', () => {
  function content(
    overrides: Partial<SelectionCalloutContent> = {}
  ): SelectionCalloutContent {
    return {
      label: textLabelSegments('Bracket · Top face'),
      detail: '2583.45 mm²',
      verbs: selectionCalloutVerbs({
        kind: 'face',
        faceCapabilities: planarFace,
        pressedAction: 'offset-face',
        availability: READY
      }),
      anchor: 'selection',
      onVerb: vi.fn(),
      onClear: vi.fn(),
      ...overrides
    };
  }

  it('draws the name, measurement, verbs and clear in one chip', () => {
    const element = document.createElement('div');
    const filled = content();
    renderSelectionCallout(element, textLabelSegments('Fallback'), filled);
    expect(element.classList.contains('selection-callout-chip')).toBe(true);
    expect(element.getAttribute('role')).toBe('group');
    expect(element.querySelector('.selection-callout-name')?.textContent).toBe(
      'Bracket · Top face'
    );
    expect(
      element.querySelector('.selection-callout-detail')?.textContent
    ).toBe('2583.45 mm²');
    const verbs = [
      ...element.querySelectorAll<HTMLButtonElement>('.selection-callout-verb')
    ];
    expect(verbs.map((verb) => verb.textContent)).toEqual([
      'Offset',
      'Sketch',
      'Hole'
    ]);
    expect(verbs[0]?.getAttribute('aria-pressed')).toBe('true');
    verbs[2]?.click();
    expect(filled.onVerb).toHaveBeenCalledWith('tool:hole');
    element
      .querySelector<HTMLButtonElement>('[aria-label="Deselect all"]')
      ?.click();
    expect(filled.onClear).toHaveBeenCalledTimes(1);
  });

  it('keeps the viewer’s own name, and only the name, without content', () => {
    const element = document.createElement('div');
    renderSelectionCallout(
      element,
      [
        { kind: 'text', text: 'Shaft · Cylindrical face ' },
        { kind: 'diameter', diameter: 12 }
      ],
      null
    );
    expect(element.classList.contains('selection-callout-chip')).toBe(false);
    expect(element.querySelector('button')).toBeNull();
    // The diameter stays a live node the radius drag can rewrite.
    expect(
      element.querySelector(`[${LIVE_DIAMETER_ATTRIBUTE}]`)
    ).not.toBeNull();
  });

  it('refills in place when only the content changes', () => {
    const element = document.createElement('div');
    renderSelectionCallout(element, textLabelSegments('Box'), content());
    refreshSelectionCallout(element, content({ verbs: [], detail: '1 mm²' }));
    expect(element.querySelectorAll('.selection-callout-verb')).toHaveLength(0);
    expect(element.textContent).toContain('1 mm²');
    refreshSelectionCallout(element, null);
    expect(element.textContent).toBe('Box');
  });
});
