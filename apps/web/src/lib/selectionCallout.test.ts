import { describe, expect, it, vi } from 'vitest';
import { selectionCapabilities } from './interaction/capabilities';
import { LIVE_DIAMETER_ATTRIBUTE } from './liveLabels';
import {
  MAX_SELECTION_VERBS,
  selectionCalloutVerbs,
  type SelectionCalloutContent,
  type SelectionCalloutOperation
} from './selectionCallout';
import {
  HANDLE_KEEP_OUT_PX,
  refreshSelectionCallout,
  renderSelectionCallout,
  selectionCalloutClearance,
  selectionCalloutObstacleShift
} from './selectionCalloutView';
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

  it('offers a primitive face Resize first, the switch the old chip held', () => {
    const verbs = selectionCalloutVerbs({
      kind: 'face',
      faceCapabilities: planarFace,
      resizeBody: true,
      pressedAction: 'resize-body',
      availability: READY
    });
    expect(verbs.map((verb) => [verb.id, verb.pressed])).toEqual([
      ['action:resize-body', true],
      ['action:offset-face', false],
      ['action:sketch-on-face', false],
      ['tool:hole', false]
    ]);
    expect(verbs[0]?.label).toBe('Resize');
  });

  it('never offers more than the cap', () => {
    expect(
      selectionCalloutVerbs({
        kind: 'face',
        faceCapabilities: planarFace,
        resizeBody: true,
        availability: READY
      }).length
    ).toBeLessThanOrEqual(MAX_SELECTION_VERBS);
  });

  it('never offers more than three verbs without a body to resize', () => {
    for (const kind of ['face', 'edges', 'body', 'bodies'] as const) {
      expect(
        selectionCalloutVerbs({
          kind,
          faceCapabilities: planarFace,
          availability: READY
        }).length
      ).toBeLessThanOrEqual(3);
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
    // Never named like the rail's own Hole or the tool card's Sketch.
    expect(verbs.map((verb) => verb.getAttribute('aria-label'))).toEqual([
      'Selection: Offset',
      'Selection: Sketch',
      'Selection: Hole'
    ]);
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

  describe('with the operation the pick armed (F11)', () => {
    function operation(
      overrides: Partial<SelectionCalloutOperation> = {}
    ): SelectionCalloutOperation {
      return {
        title: 'Fillet',
        phase: 'armed',
        onEditCulprit: vi.fn(),
        onViewDetails: vi.fn(),
        onKeepLastValid: vi.fn(),
        onSelectAllEdges: vi.fn(),
        ...overrides
      };
    }
    const edgeVerbs = selectionCalloutVerbs({
      kind: 'edges',
      edgesArmed: true,
      pressedAction: 'fillet',
      availability: READY
    });

    it('is announced as the operation, its lit verb the only armed mark', () => {
      const element = document.createElement('div');
      renderSelectionCallout(
        element,
        textLabelSegments('Box'),
        content({ verbs: edgeVerbs, operation: operation() })
      );
      // The name the column-top chip had, so it is still one region.
      expect(element.getAttribute('role')).toBe('region');
      expect(element.getAttribute('aria-label')).toBe('Fillet operation');
      // Armed is the resting state: no "Ready" pill repeats what the pressed
      // verb already says.
      expect(element.querySelector('.selection-callout-phase')).toBeNull();
      expect(element.querySelector('.selection-callout-phase-dot')).toBeNull();
      expect(element.textContent).not.toContain('Ready');
      // The Fillet/Chamfer switch is the chip's own pressed verbs.
      expect(
        [...element.querySelectorAll('.selection-callout-verb')].map((verb) => [
          verb.textContent,
          verb.getAttribute('aria-pressed')
        ])
      ).toEqual([
        ['Fillet', 'true'],
        ['Chamfer', 'false']
      ]);
    });

    it('collapses the phase to a named mark while dragging', () => {
      const element = document.createElement('div');
      renderSelectionCallout(
        element,
        textLabelSegments('Box'),
        content({ operation: operation({ phase: 'dragging' }) })
      );
      expect(element.querySelector('.selection-callout-phase')).toBeNull();
      expect(
        element
          .querySelector('.selection-callout-phase-dot')
          ?.getAttribute('aria-label')
      ).toBe('Dragging');
    });

    it('holds its switch still while the exact check runs', () => {
      const element = document.createElement('div');
      renderSelectionCallout(
        element,
        textLabelSegments('Box'),
        content({ operation: operation({ phase: 'validating' }) })
      );
      expect(element.getAttribute('aria-busy')).toBe('true');
      const byLabel = (label: string) =>
        element.querySelector<HTMLButtonElement>(
          `[aria-label="Selection: ${label}"]`
        );
      // Actions and tools both wait: the exact check owns the pick.
      expect(byLabel('Offset')?.disabled).toBe(true);
      expect(byLabel('Hole')?.disabled).toBe(true);
    });

    it('locks deselection until the exact check answers', () => {
      const element = document.createElement('div');
      const onClear = vi.fn();
      renderSelectionCallout(
        element,
        textLabelSegments('Box'),
        content({
          onClear,
          operation: operation({ phase: 'validating' })
        })
      );
      const clear = () =>
        element.querySelector<HTMLButtonElement>(
          '[aria-label="Deselect all"]'
        )!;
      expect(clear().disabled).toBe(true);
      clear().click();
      expect(onClear).not.toHaveBeenCalled();

      refreshSelectionCallout(
        element,
        content({ onClear, operation: operation({ phase: 'failed' }) })
      );
      expect(clear().disabled).toBe(false);
      clear().click();
      expect(onClear).toHaveBeenCalledTimes(1);
    });

    it.each(['failed', 'armed', 'completed'] as const)(
      'unlocks every chip control after validation becomes %s',
      (phase) => {
        const element = document.createElement('div');
        const onVerb = vi.fn();
        const onClear = vi.fn();
        const actions = operation({
          phase: 'validating',
          selectAllEdgesCount: 12
        });
        const verbs = selectionCalloutVerbs({
          kind: 'face',
          faceCapabilities: planarFace,
          availability: READY
        });
        renderSelectionCallout(
          element,
          textLabelSegments('Box'),
          content({ verbs, onVerb, onClear, operation: actions })
        );
        for (const control of element.querySelectorAll<HTMLButtonElement>(
          'button'
        )) {
          expect(control.disabled).toBe(true);
          control.click();
        }
        expect(onVerb).not.toHaveBeenCalled();
        expect(onClear).not.toHaveBeenCalled();
        expect(actions.onSelectAllEdges).not.toHaveBeenCalled();

        refreshSelectionCallout(
          element,
          content({
            verbs,
            onVerb,
            onClear,
            operation: phase === 'completed' ? undefined : { ...actions, phase }
          })
        );
        for (const control of element.querySelectorAll<HTMLButtonElement>(
          'button'
        )) {
          expect(control.disabled).toBe(false);
          control.click();
        }
        expect(onVerb).toHaveBeenCalledTimes(verbs.length);
        expect(onClear).toHaveBeenCalledTimes(1);
        expect(actions.onSelectAllEdges).toHaveBeenCalledTimes(
          phase === 'completed' ? 0 : 1
        );
      }
    );

    it('says why it refused, with each way out as a button', () => {
      const element = document.createElement('div');
      const filled = operation({
        phase: 'failed',
        error: {
          message: 'Fillet could not be created with radius 30.',
          detail: 'BRep_API: command not done',
          culprit: { featureId: 'f-1', featureName: 'Fillet 1' }
        },
        keepLastValidLabel: 'Keep 2.5 mm'
      });
      renderSelectionCallout(
        element,
        textLabelSegments('Box'),
        content({ verbs: edgeVerbs, operation: filled })
      );
      const refusal = element.querySelector('[role="alert"]');
      expect(refusal?.textContent).toContain(
        'Fillet could not be created with radius 30.'
      );
      expect(
        element.querySelector('.selection-callout-phase')?.textContent
      ).toBe('Failed');
      const recovery = [
        ...element.querySelectorAll<HTMLButtonElement>(
          '.selection-callout-recovery'
        )
      ];
      expect(recovery.map((button) => button.textContent)).toEqual([
        'Edit Fillet 1',
        'Keep 2.5 mm',
        'View details'
      ]);
      recovery[0]?.click();
      recovery[1]?.click();
      recovery[2]?.click();
      expect(filled.onEditCulprit).toHaveBeenCalledWith('f-1');
      expect(filled.onKeepLastValid).toHaveBeenCalledTimes(1);
      expect(filled.onViewDetails).toHaveBeenCalledTimes(1);
    });

    it('offers every edge of the body until all are picked', () => {
      const element = document.createElement('div');
      const filled = operation({ selectAllEdgesCount: 12 });
      renderSelectionCallout(
        element,
        textLabelSegments('Box'),
        content({ verbs: edgeVerbs, operation: filled })
      );
      element
        .querySelector<HTMLButtonElement>('[aria-label="Select all 12 edges"]')
        ?.click();
      expect(filled.onSelectAllEdges).toHaveBeenCalledTimes(1);
    });

    it('goes back to a plain selection group when the operation ends', () => {
      const element = document.createElement('div');
      renderSelectionCallout(
        element,
        textLabelSegments('Box'),
        content({ operation: operation({ phase: 'validating' }) })
      );
      refreshSelectionCallout(element, content());
      expect(element.getAttribute('role')).toBe('group');
      expect(element.getAttribute('aria-label')).toBe('Selection');
      expect(element.hasAttribute('aria-busy')).toBe(false);
      expect(element.querySelector('.selection-callout-phase')).toBeNull();
    });
  });
});

describe('selectionCalloutClearance', () => {
  const viewport = { left: 0, top: 0, right: 1000, bottom: 800 };
  const valueChip = { left: 500, top: 400, right: 600, bottom: 424 };

  it('leaves a chip far from the handle where it is', () => {
    expect(
      selectionCalloutClearance(
        { left: 100, top: 100, right: 300, bottom: 124 },
        valueChip,
        viewport
      )
    ).toBe(0);
  });

  it('lifts a chip over the handle clear of the arrow', () => {
    const chip = { left: 450, top: 380, right: 700, bottom: 404 };
    const shift = selectionCalloutClearance(chip, valueChip, viewport);
    expect(shift).toBeLessThan(0);
    expect(chip.bottom + shift).toBeLessThanOrEqual(
      valueChip.top - HANDLE_KEEP_OUT_PX
    );
  });

  it('drops below the handle when there is no room above', () => {
    const high = { left: 500, top: 80, right: 600, bottom: 104 };
    const chip = { left: 450, top: 90, right: 700, bottom: 114 };
    const shift = selectionCalloutClearance(chip, high, viewport);
    expect(shift).toBeGreaterThan(0);
    expect(chip.top + shift).toBeGreaterThanOrEqual(
      high.bottom + HANDLE_KEEP_OUT_PX
    );
  });
});

describe('selectionCalloutObstacleShift', () => {
  const viewport = { left: 0, top: 50, right: 1100, bottom: 700 };
  // The inspector in the right lane, as measured at 1100 px (F11).
  const inspector = { left: 710, top: 60, right: 1040, bottom: 394 };

  it('leaves a chip clear of every panel where it is', () => {
    expect(
      selectionCalloutObstacleShift(
        { left: 100, top: 120, right: 500, bottom: 146 },
        [inspector],
        viewport
      )
    ).toEqual({ dx: 0, dy: 0 });
  });

  it('slides a chip out from under the inspector, not under another panel', () => {
    const chip = { left: 307, top: 126, right: 793, bottom: 152 };
    const shift = selectionCalloutObstacleShift(chip, [inspector], viewport);
    expect(shift.dy).toBe(0);
    expect(chip.right + shift.dx).toBeLessThanOrEqual(inspector.left);
    expect(chip.left + shift.dx).toBeGreaterThanOrEqual(viewport.left);
  });

  it('rises above a drawer that spans the viewport', () => {
    // A phone: the drawer covers the lower viewport edge to edge.
    const phone = { left: 0, top: 50, right: 390, bottom: 844 };
    const drawer = { left: 0, top: 500, right: 390, bottom: 844 };
    const chip = { left: 60, top: 520, right: 330, bottom: 546 };
    const shift = selectionCalloutObstacleShift(chip, [drawer], phone);
    expect(shift.dx).toBe(0);
    expect(chip.bottom + shift.dy).toBeLessThanOrEqual(drawer.top);
  });

  it('stays put rather than move under another panel', () => {
    const lane = { left: 300, top: 0, right: 400, bottom: 800 };
    const column = { left: 0, top: 0, right: 300, bottom: 800 };
    const narrow = { left: 0, top: 0, right: 400, bottom: 800 };
    expect(
      selectionCalloutObstacleShift(
        { left: 250, top: 100, right: 350, bottom: 120 },
        [lane, column],
        narrow
      )
    ).toEqual({ dx: 0, dy: 0 });
  });
});
