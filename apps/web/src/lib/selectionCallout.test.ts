import { describe, expect, it, vi } from 'vitest';
import { selectionCapabilities } from './interaction/capabilities';
import { LIVE_DIAMETER_ATTRIBUTE } from './liveLabels';
import {
  editFaceVerb,
  faceDetailsVerb,
  MAX_SELECTION_VERBS,
  selectionCalloutVerbs,
  type SelectionCalloutContent,
  type SelectionCalloutOperation
} from './selectionCallout';
import {
  HANDLE_KEEP_OUT_PX,
  refreshSelectionCallout,
  renderSelectionCallout,
  placeSelectionCallouts,
  selectionCalloutPlacement,
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
  it('offers a planar face its offset and every tool that starts from it', () => {
    const verbs = selectionCalloutVerbs({
      kind: 'face',
      faceCapabilities: planarFace,
      pressedAction: 'offset-face',
      availability: READY
    });
    expect(verbs.map((verb) => verb.label)).toEqual([
      'Offset',
      'Sketch',
      'Hole',
      'Shell',
      'Draft',
      'Thicken',
      'Plane'
    ]);
    expect(verbs.map((verb) => verb.id)).toEqual([
      'action:offset-face',
      'action:sketch-on-face',
      'tool:hole',
      'tool:shell',
      'tool:draft',
      'tool:thicken',
      'tool:datum-plane'
    ]);
    // The armed operation reads as pressed; the others do not.
    expect(verbs.map((verb) => verb.pressed)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false
    ]);
  });

  it('offers a cylindrical face its diameter, an axis and a shell', () => {
    const verbs = selectionCalloutVerbs({
      kind: 'face',
      faceCapabilities: selectionCapabilities({
        kind: 'face',
        target: { surfaceType: 'cylindrical', hash: 8, radius: 5 }
      }),
      availability: READY
    });
    expect(verbs.slice(-2).map((verb) => verb.id)).toEqual([
      'tool:datum-axis',
      'tool:shell'
    ]);
    expect(verbs.map((verb) => verb.id)).not.toContain('tool:hole');
  });

  it('falls back to the tools when the machine does not hold the face', () => {
    const verbs = selectionCalloutVerbs({
      kind: 'face',
      faceCapabilities: null,
      availability: READY
    });
    expect(verbs.map((verb) => verb.id)).toEqual([
      'tool:sketch',
      'tool:hole',
      'tool:shell'
    ]);
  });

  it('chooses an unarmed face its tools by the kind of face it is', () => {
    const ids = (faceSurface: 'planar' | 'cylindrical' | 'other') =>
      selectionCalloutVerbs({
        kind: 'face',
        faceCapabilities: null,
        faceSurface,
        availability: READY
      }).map((verb) => verb.id);
    expect(ids('planar')).toEqual([
      'tool:sketch',
      'tool:hole',
      'tool:shell',
      'tool:draft',
      'tool:thicken',
      'tool:datum-plane'
    ]);
    expect(ids('cylindrical')).toEqual(['tool:datum-axis', 'tool:shell']);
    expect(ids('other')).toEqual(['tool:shell']);
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
      ['action:chamfer', false],
      ['tool:datum-axis', false]
    ]);
    const unarmed = selectionCalloutVerbs({
      kind: 'edges',
      availability: READY
    });
    expect(unarmed.map((verb) => verb.id)).toEqual([
      'tool:fillet',
      'tool:chamfer',
      'tool:datum-axis'
    ]);
  });

  it('offers a body the tools that take one, and several bodies the booleans', () => {
    expect(
      selectionCalloutVerbs({ kind: 'body', availability: READY }).map(
        (verb) => verb.label
      )
    ).toEqual([
      'Move',
      'Rotate',
      'Scale',
      'Mirror',
      'Split',
      'Pattern',
      'Solid offset'
    ]);
    expect(
      selectionCalloutVerbs({ kind: 'bodies', availability: READY }).map(
        (verb) => verb.label
      )
    ).toEqual(['Union', 'Subtract', 'Intersect', 'Move']);
    // A box sweep's faces: the tools that take a list of faces.
    expect(
      selectionCalloutVerbs({ kind: 'faces', availability: READY }).map(
        (verb) => verb.label
      )
    ).toEqual(['Shell', 'Draft']);
  });

  it('disables a datum verb on a pick no datum can follow, and says why', () => {
    const reason = 'An axis runs along a straight edge; this edge is curved.';
    const axis = selectionCalloutVerbs({
      kind: 'edges',
      datumRefusal: reason,
      availability: READY
    }).find((verb) => verb.id === 'tool:datum-axis');
    expect(axis).toMatchObject({ disabled: true, title: reason });
    const plane = selectionCalloutVerbs({
      kind: 'face',
      faceCapabilities: planarFace,
      datumRefusal: 'no identity',
      availability: READY
    }).find((verb) => verb.id === 'tool:datum-plane');
    expect(plane).toMatchObject({ disabled: true, title: 'no identity' });
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
    expect(verbs.slice(0, 4).map((verb) => [verb.id, verb.pressed])).toEqual([
      ['action:resize-body', true],
      ['action:offset-face', false],
      ['action:sketch-on-face', false],
      ['tool:hole', false]
    ]);
    expect(verbs[0]?.label).toBe('Resize');
  });

  it('offers a region its profile tools, and several regions Extrude', () => {
    expect(
      selectionCalloutVerbs({ kind: 'region', availability: READY }).map(
        (verb) => verb.id
      )
    ).toEqual(['tool:extrude', 'tool:revolve', 'tool:sweep', 'tool:loft']);
    // Revolve, Sweep and Loft take one region of a sketch at a time.
    expect(
      selectionCalloutVerbs({ kind: 'regions', availability: READY }).map(
        (verb) => verb.id
      )
    ).toEqual(['tool:extrude']);
  });

  it('keeps the verbs a primitive face had before More', () => {
    // The card's buttons are the first MAX_SELECTION_VERBS: the four the
    // card always showed, so the extra tools never push one behind More.
    expect(
      selectionCalloutVerbs({
        kind: 'face',
        faceCapabilities: planarFace,
        resizeBody: true,
        availability: READY
      })
        .slice(0, MAX_SELECTION_VERBS)
        .map((verb) => verb.label)
    ).toEqual(['Resize', 'Offset', 'Sketch', 'Hole']);
  });
});

describe('faceDetailsVerb', () => {
  it('reads an imported face without an edit, even while editing is locked', () => {
    expect(faceDetailsVerb(false)).toMatchObject({
      id: 'edit-face',
      label: 'Face details',
      disabled: false,
      pressed: false
    });
    expect(faceDetailsVerb(true).pressed).toBe(true);
  });
});

describe('editFaceVerb', () => {
  it('offers the imported face edit, pressed while its card is open', () => {
    expect(editFaceVerb(false)).toMatchObject({
      id: 'edit-face',
      disabled: false,
      pressed: false
    });
    expect(editFaceVerb(true).pressed).toBe(true);
  });

  it('is disabled with the reason while the project cannot be edited', () => {
    const reason = 'This project is open in another tab';
    expect(editFaceVerb(false, reason)).toMatchObject({
      disabled: true,
      title: reason
    });
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
    expect(verbs.map((verb) => verb.textContent).slice(0, 3)).toEqual([
      'Offset',
      'Sketch',
      'Hole'
    ]);
    expect(verbs[0]?.getAttribute('aria-pressed')).toBe('true');
    // Never named like the rail's own Hole or the tool card's Sketch.
    expect(
      verbs.map((verb) => verb.getAttribute('aria-label')).slice(0, 3)
    ).toEqual(['Selection: Offset', 'Selection: Sketch', 'Selection: Hole']);
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
        ['Chamfer', 'false'],
        ['Axis', 'false']
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

describe('selection callout placement', () => {
  const bounds = { left: 4, top: 52, right: 1196, bottom: 846 };
  const handle = { left: 690, top: 225, right: 840, bottom: 249 };

  it('leaves a chip clear of the chrome and handle at its anchor', () => {
    expect(
      selectionCalloutPlacement(
        { left: 100, top: 100, right: 300, bottom: 124 },
        bounds,
        [],
        handle
      )
    ).toEqual({ dx: 0, dy: 0 });
  });

  it('keeps a phone chip inside the viewport and above its drawer', () => {
    const chip = { left: 200, top: 520, right: 566, bottom: 610 };
    const phone = { left: 4, top: 52, right: 386, bottom: 840 };
    const drawer = { left: 0, top: 500, right: 390, bottom: 844 };
    const shift = selectionCalloutPlacement(chip, phone, [drawer], null);
    expect(chip.left + shift.dx).toBeGreaterThanOrEqual(phone.left);
    expect(chip.right + shift.dx).toBeLessThanOrEqual(phone.right);
    expect(chip.top + shift.dy).toBeGreaterThanOrEqual(phone.top);
    expect(chip.bottom + shift.dy).toBeLessThan(drawer.top);
  });

  it('clears the handle and toolbar together when there is no room above', () => {
    const chip = { left: 388, top: 136, right: 988, bottom: 226 };
    const shift = selectionCalloutPlacement(chip, bounds, [], handle);
    expect(chip.top + shift.dy).toBeGreaterThanOrEqual(bounds.top);
    expect(chip.bottom + shift.dy).toBeLessThanOrEqual(bounds.bottom);
    expect(chip.top + shift.dy).toBeGreaterThan(
      handle.bottom + HANDLE_KEEP_OUT_PX
    );
  });

  it('clears a handle and a side panel with one combined offset', () => {
    const chip = { left: 600, top: 300, right: 900, bottom: 390 };
    const panel = { left: 800, top: 52, right: 1196, bottom: 600 };
    const shift = selectionCalloutPlacement(chip, bounds, [panel], handle);
    const placed = {
      left: chip.left + shift.dx,
      right: chip.right + shift.dx,
      top: chip.top + shift.dy,
      bottom: chip.bottom + shift.dy
    };
    expect(placed.right <= panel.left || placed.top >= panel.bottom).toBe(true);
    expect(
      placed.right < handle.left - HANDLE_KEEP_OUT_PX ||
        placed.left > handle.right + HANDLE_KEEP_OUT_PX ||
        placed.bottom < handle.top - HANDLE_KEEP_OUT_PX ||
        placed.top > handle.bottom + HANDLE_KEEP_OUT_PX
    ).toBe(true);
  });

  it.each([24, 90])(
    'holds a stationary %i px chip across repeated render frames and clears its offset when the handle hides',
    (height) => {
      const root = document.createElement('div');
      root.className = 'app-shell';
      root.innerHTML = `<div class="topbar"></div><div class="viewer-area"><div class="viewer-shell"><div class="labels"><div class="selection-callout selection-callout-chip"></div></div><div class="handle-value-chip"></div></div></div>`;
      document.body.append(root);
      try {
        const container = root.querySelector<HTMLElement>('.labels')!;
        const chip = root.querySelector<HTMLElement>(
          '.selection-callout-chip'
        )!;
        const value = root.querySelector<HTMLElement>('.handle-value-chip')!;
        chip.style.marginTop = '-34px';
        vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(
          new DOMRect(0, 0, 1200, 850)
        );
        vi.spyOn(
          root.querySelector('.topbar')!,
          'getBoundingClientRect'
        ).mockReturnValue(new DOMRect(0, 0, 1200, 48));
        vi.spyOn(value, 'getBoundingClientRect').mockReturnValue(
          new DOMRect(handle.left, handle.top, 150, 24)
        );
        vi.spyOn(chip, 'getBoundingClientRect').mockImplementation(() => {
          const [x, y] = chip.style.translate
            .split(/\s+/)
            .map(Number.parseFloat);
          return new DOMRect(
            388 + (x || 0),
            170 + Number.parseFloat(chip.style.marginTop) + (y || 0),
            600,
            height
          );
        });
        placeSelectionCallouts(container);
        const first = chip.getBoundingClientRect();
        expect(first.top).toBeGreaterThanOrEqual(bounds.top);
        for (let frame = 0; frame < 120; frame += 1) {
          placeSelectionCallouts(container);
          expect(chip.getBoundingClientRect().toJSON()).toEqual(first.toJSON());
        }
        expect(chip.style.marginTop).toBe('-34px');
        value.hidden = true;
        placeSelectionCallouts(container);
        expect(chip.style.translate).toBe('');
        expect(chip.getBoundingClientRect().top).toBe(136);
      } finally {
        root.remove();
      }
    }
  );
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
