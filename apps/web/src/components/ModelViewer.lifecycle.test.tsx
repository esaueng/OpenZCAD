import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from 'vitest';
import { StrictMode, createElement } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import type * as Three from 'three';
import type * as Viewport from '@openzcad/viewport';
import type { ModelViewerProps } from './ModelViewer';
import type { FrameSample } from '../lib/frameStats';

/**
 * The viewer's mount/unmount lifecycle, with the real ModelViewer mounted in
 * happy-dom over a counting stand-in for WebGLRenderer.
 *
 * ViewerShell keys the viewer by project, so every project open builds a
 * fresh one and retires the last. A retired viewer that stays reachable keeps
 * its WebGL context and the GPU memory behind it, until the page reaches the
 * browser's cap on live contexts and the browser starts losing the oldest.
 */
const gl = vi.hoisted(() => {
  const state = {
    created: 0,
    disposed: 0,
    contextsLost: 0,
    shadowLightsDisposed: 0
  };
  class CountingRenderer {
    domElement: HTMLCanvasElement;
    shadowMap = {
      enabled: false,
      autoUpdate: true,
      needsUpdate: false,
      type: 0
    };
    info = {
      render: { triangles: 0, calls: 0 },
      memory: { textures: 0, geometries: 0 }
    };
    outputColorSpace = '';
    localClippingEnabled = false;
    toneMapping = 0;
    toneMappingExposure = 1;
    contextLost = false;
    private ratio = 1;
    constructor() {
      state.created += 1;
      this.domElement = document.createElement('canvas');
    }
    setSize() {}
    setPixelRatio(value: number) {
      this.ratio = value;
    }
    getPixelRatio() {
      return this.ratio;
    }
    setClearColor() {}
    render() {}
    getContext() {
      return { isContextLost: () => this.contextLost };
    }
    dispose() {
      state.disposed += 1;
    }
    forceContextLoss() {
      state.contextsLost += 1;
      this.contextLost = true;
    }
    compile() {}
  }
  class StubPmrem {
    fromScene() {
      return { texture: { dispose() {} } };
    }
    dispose() {}
  }
  return { state, CountingRenderer, StubPmrem };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof Three>();
  class CountingDirectionalLight extends actual.DirectionalLight {
    override dispose() {
      if (this.castShadow) {
        gl.state.shadowLightsDisposed += 1;
      }
      super.dispose();
    }
  }
  return {
    ...actual,
    DirectionalLight: CountingDirectionalLight,
    WebGLRenderer: gl.CountingRenderer,
    PMREMGenerator: gl.StubPmrem
  };
});

const rigEvents = vi.hoisted(() => [] as string[]);
/** Every label element the viewer made, in order, to find the pick chip. */
const madeLabels = vi.hoisted(() => [] as HTMLElement[]);
vi.mock('@openzcad/viewport', async (importOriginal) => {
  const actual = await importOriginal<typeof Viewport>();
  const track = (rig: ReturnType<typeof actual.buildOffsetFaceHandle>) => {
    const exit = rig.beginExit!;
    rig.beginExit = () => {
      rigEvents.push(`exit:${rig.kind}`);
      exit();
    };
    const dispose = rig.dispose;
    rig.dispose = () => {
      rigEvents.push(`dispose:${rig.kind}`);
      dispose();
    };
    return rig;
  };
  return {
    ...actual,
    makeLabel: (...args: Parameters<typeof actual.makeLabel>) => {
      const label = actual.makeLabel(...args);
      madeLabels.push(label.element);
      return label;
    },
    buildOffsetFaceHandle: (
      ...args: Parameters<typeof actual.buildOffsetFaceHandle>
    ) => {
      rigEvents.push('build:offset-face');
      return track(actual.buildOffsetFaceHandle(...args));
    },
    buildCylinderRadiusHandle: (
      ...args: Parameters<typeof actual.buildCylinderRadiusHandle>
    ) => {
      rigEvents.push('build:cylinder-radius');
      return track(actual.buildCylinderRadiusHandle(...args));
    }
  };
});
const THREE = await import('three');

const { ModelViewer } = await import('./ModelViewer');
const { prepareBody } = await import('./viewer/prepareBody');
const { BODY_PREPARATION_TRIANGLES } =
  await import('./viewer/bodyPreparationPolicy');

const CALLBACKS = [
  'onViewChange',
  'onViewSettled',
  'onGeometryPresented',
  'onBodiesDrawnElsewhere',
  'onWheelDeviceLearned',
  'onSelectTopology',
  'onSelectEdgeChain',
  'onBoxSelect',
  'onOffsetPreview',
  'onOffsetCommit',
  'onOffsetCancel',
  'onOpenOffsetKeypad',
  'onCylinderDimensionModeChange',
  'onCylinderRadiusPreview',
  'onCylinderRadiusCommit',
  'onCylinderRadiusCancel',
  'onOpenCylinderRadiusKeypad',
  'onEdgeRadiusPreview',
  'onEdgeCommit',
  'onEdgeCancel',
  'onOpenEdgeKeypad',
  'onDirectManipulationChange',
  'onSelectRegion',
  'onHoverRegion',
  'onPickPlane',
  'onMeasurePreview',
  'onSketchCommit',
  'onEditSketchDimension',
  'onMoveSketchDimension',
  'onSketchDrawingChange',
  'onSketchMoveChange',
  'onSketchMoveCommit',
  'onSketchSelectObject',
  'onSelectSketchProfile',
  'onResizePrimitiveFace',
  'onMovePreviewChange',
  'onContextMenu'
];

const REFS = [
  'orientationRef',
  'orientationDragRef',
  'scaleIndicatorRef',
  'sketchGridReadoutRef',
  'frameStatsRef',
  'keypadAnchorRef',
  'offsetSetterRef',
  'cylinderRadiusLabelSetterRef',
  'cancelDirectManipulationRef',
  'openExactEntryRef',
  'sketchTextAnchorRef',
  'moveValuesSetterRef'
];

/** Every prop the viewer reads, at its idle value: an empty project. */
function idleProps(): ModelViewerProps {
  const props: Record<string, unknown> = {
    bodies: [],
    sketches: [],
    measurementAnnotations: [],
    selectedBodyIds: [],
    selectedTopology: null,
    previewFaceHighlights: [],
    selectedEdges: [],
    pickListEnabled: true,
    settings: { showGrid: true, displayMode: 'shaded-edges' },
    exactSection: null,
    fitSignal: 0,
    viewRequest: null,
    normalToFaceRequest: null,
    units: 'mm',
    editableBodyIds: [],
    movePreview: null,
    moveCommitHold: null,
    appearancePreview: null,
    projection: 'perspective',
    initialView: null,
    selectionFilter: 'any',
    offsetHandle: null,
    offsetDragTarget: null,
    offsetPreviewInvalid: false,
    previewDeferred: false,
    cylinderRadiusHandle: null,
    cylinderDimensionMode: 'diameter',
    edgeHandle: null,
    sketchViews: [],
    selectedProfileIds: [],
    profileSelectionMode: false,
    planePickerArmed: false,
    planePickerOffset: 0,
    regionHandle: null,
    sketchMode: null
  };
  for (const name of CALLBACKS) {
    props[name] = vi.fn(() => false);
  }
  for (const name of REFS) {
    props[name] = { current: null };
  }
  return props as unknown as ModelViewerProps;
}

/** Mounts one viewer per project, retiring each as the next opens. */
function openProjects(count: number) {
  const viewer = (index: number) =>
    createElement(ModelViewer, { key: `project-${index}`, ...idleProps() });
  const view = render(viewer(0));
  for (let index = 1; index < count; index += 1) {
    view.rerender(viewer(index));
  }
  return view;
}

/** Key listeners still registered on `window` and `document`. */
function trackKeyListeners() {
  const live: {
    target: EventTarget;
    type: string;
    listener: unknown;
    capture: boolean;
  }[] = [];
  const restore: (() => void)[] = [];
  const captureOf = (options: unknown) =>
    typeof options === 'boolean'
      ? options
      : Boolean((options as { capture?: boolean } | undefined)?.capture);
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener;
    const remove = target.removeEventListener;
    target.addEventListener = function (type, listener, options) {
      if (type === 'keydown' || type === 'keyup') {
        live.push({ target, type, listener, capture: captureOf(options) });
      }
      return add.call(this, type, listener, options);
    };
    target.removeEventListener = function (type, listener, options) {
      const index = live.findIndex(
        (entry) =>
          entry.target === target &&
          entry.type === type &&
          entry.listener === listener &&
          entry.capture === captureOf(options)
      );
      if (index >= 0) {
        live.splice(index, 1);
      }
      return remove.call(this, type, listener, options);
    };
    restore.push(() => {
      target.addEventListener = add;
      target.removeEventListener = remove;
    });
  }
  return { live, restore: () => restore.forEach((undo) => undo()) };
}

const LAYOUT_KEYS = [
  ['clientWidth', 800],
  ['offsetWidth', 800],
  ['clientHeight', 600],
  ['offsetHeight', 600]
] as const;
const layoutDescriptors = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  // happy-dom lays nothing out; give the host a size to frame.
  for (const [key, value] of LAYOUT_KEYS) {
    layoutDescriptors.set(
      key,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)
    );
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get: () => value
    });
  }
});

afterAll(() => {
  for (const [key] of LAYOUT_KEYS) {
    const descriptor = layoutDescriptors.get(key);
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, key, descriptor);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  madeLabels.length = 0;
  rigEvents.length = 0;
  gl.state.created = 0;
  gl.state.disposed = 0;
  gl.state.contextsLost = 0;
  gl.state.shadowLightsDisposed = 0;
});

describe('ModelViewer lifecycle', () => {
  it('breaks frame continuity across browser visibility pauses and resumes it during animation', () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let next = 0;
    const request = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callbacks.set(++next, callback);
        return next;
      });
    const cancel = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((id) => {
        callbacks.delete(id);
      });
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('visible');
    const samples: FrameSample[] = [];
    const props = idleProps();
    props.viewRequest = { view: 'top', nonce: 1 };
    props.frameStatsRef = { current: (sample) => samples.push(sample) };
    const view = render(createElement(ModelViewer, props));
    let at = performance.now();
    const step = () => {
      const entry = callbacks.entries().next().value;
      expect(entry).toBeDefined();
      callbacks.delete(entry![0]);
      act(() => entry![1]((at += 16)));
    };
    try {
      step();
      step();
      expect(samples.at(-1)?.continuous).toBe(true);
      visibility.mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      step();
      expect(samples.at(-1)?.continuous).toBe(false);
      visibility.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      step();
      expect(samples.at(-1)?.continuous).toBe(false);
      step();
      expect(samples.at(-1)?.continuous).toBe(true);
    } finally {
      view.unmount();
      request.mockRestore();
      cancel.mockRestore();
      visibility.mockRestore();
    }
  });

  it('retires the cylinder handle before building a planar handle in the same commit', () => {
    const props = idleProps();
    props.cylinderRadiusHandle = {
      bodyId: 'body_1',
      topologyId: 'wall',
      point: { x: 10, y: 0, z: 5 },
      radialDirection: { x: 1, y: 0, z: 0 },
      originalRadius: 10,
      axisStart: { x: 0, y: 0, z: 0 },
      axisEnd: { x: 0, y: 0, z: 10 },
      smoothPreview: false
    };
    const view = render(createElement(ModelViewer, props));
    rigEvents.length = 0;
    const planar = {
      bodyId: 'body_1',
      topologyId: 'cap',
      point: { x: 0, y: 0, z: 10 },
      normal: { x: 0, y: 0, z: 1 }
    };
    view.rerender(
      createElement(ModelViewer, {
        ...props,
        cylinderRadiusHandle: null,
        offsetHandle: planar,
        offsetDragTarget: planar
      })
    );
    // The exiting cylinder can fade, but it must relinquish the active slot
    // before the planar handle claims it (and the shared chip).
    expect(rigEvents).toEqual(['exit:cylinder-radius', 'build:offset-face']);
    rigEvents.length = 0;
    view.rerender(
      createElement(ModelViewer, { ...props, cylinderRadiusHandle: null })
    );
    expect(rigEvents).toEqual(['exit:offset-face']);
    view.unmount();
  });

  it('keeps the entry rig while the chip input changes, and swaps a refused validation without fading', () => {
    const props = idleProps();
    const handle = {
      bodyId: 'body_1',
      topologyId: 'cap',
      point: { x: 0, y: 0, z: 10 },
      normal: { x: 0, y: 0, z: 1 },
      initialValue: 5
    };
    props.offsetDragTarget = handle;
    props.offsetHandle = { ...handle, entry: true, inputValue: -40 };
    const view = render(createElement(ModelViewer, props));
    rigEvents.length = 0;
    view.rerender(
      createElement(ModelViewer, {
        ...props,
        offsetHandle: { ...handle, entry: true, inputValue: 3 }
      })
    );
    expect(rigEvents).toEqual([]);
    view.rerender(
      createElement(ModelViewer, {
        ...props,
        offsetHandle: { ...handle, locked: true }
      })
    );
    rigEvents.length = 0;
    view.rerender(
      createElement(ModelViewer, {
        ...props,
        offsetHandle: { ...handle, inputValue: -40 }
      })
    );
    expect(rigEvents).toEqual(['dispose:offset-face', 'build:offset-face']);
    view.unmount();
  });

  it.each(['body', 'face', 'deselect'] as const)(
    'preserves a drag through a transient null handle, then cancels a changed %s',
    (changed) => {
      const props = idleProps();
      const handle = {
        bodyId: 'body_1',
        topologyId: 'cap',
        point: { x: 0, y: 0, z: 10 },
        normal: { x: 0, y: 0, z: 1 }
      };
      props.offsetHandle = handle;
      props.offsetDragTarget = handle;
      const view = render(createElement(ModelViewer, props));
      const hit = new THREE.Mesh();
      hit.userData.directHandle = true;
      const raycast = vi
        .spyOn(THREE.Raycaster.prototype, 'intersectObjects')
        .mockReturnValue([
          { object: hit, distance: 1, point: new THREE.Vector3() }
        ]);
      try {
        fireEvent.pointerDown(view.container.querySelector('canvas')!, {
          button: 0,
          pointerId: 7,
          pointerType: 'mouse',
          clientX: 400,
          clientY: 300
        });
        expect(props.onDirectManipulationChange).toHaveBeenLastCalledWith(true);
        rigEvents.length = 0;
        view.rerender(
          createElement(ModelViewer, { ...props, offsetHandle: null })
        );
        expect(props.onOffsetCancel).not.toHaveBeenCalled();
        expect(props.onDirectManipulationChange).toHaveBeenCalledTimes(1);
        expect(rigEvents).toEqual([]);
        view.rerender(createElement(ModelViewer, props));
        expect(props.onOffsetCancel).not.toHaveBeenCalled();
        const target =
          changed === 'deselect'
            ? null
            : {
                ...handle,
                ...(changed === 'body'
                  ? { bodyId: 'body_2' }
                  : { topologyId: 'other-cap' })
              };
        view.rerender(
          createElement(ModelViewer, {
            ...props,
            offsetHandle: null,
            offsetDragTarget: target
          })
        );
        expect(props.onOffsetCancel).toHaveBeenCalledOnce();
        expect(props.onDirectManipulationChange).toHaveBeenLastCalledWith(
          false
        );
      } finally {
        raycast.mockRestore();
        view.unmount();
      }
    }
  );

  it('never lights the held frame’s chip with the live frame’s label flag while a dense commit prepares', () => {
    // The commit's dense body prepares off the main thread, so the viewer
    // keeps drawing the validating frame: its body, its pick and its chip
    // content. The App shows the chip only without a card (`pickLabel`).
    // A neutral commit drops the card and the pick together, so the live
    // flag turns on as the live chip goes away. Read live, that flag lit
    // the held frame's chip (verbs, "Validating") over the model.
    const workers: {
      postMessage: ReturnType<typeof vi.fn>;
      onmessage?: (event: MessageEvent) => void;
    }[] = [];
    vi.stubGlobal(
      'Worker',
      class {
        postMessage = vi.fn();
        terminate = vi.fn();
        onmessage?: (event: MessageEvent) => void;
        constructor() {
          workers.push(this);
        }
      }
    );
    let revision = 0;
    const dense = () => ({
      bodyId: 'part',
      name: 'Part',
      source: 'primitive',
      color: '#334455',
      faceCount: 1,
      consumed: false,
      exportableStep: true,
      bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      mesh: {
        kind: 'mesh',
        vertices: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, ++revision),
        indices: Uint32Array.from(
          { length: (BODY_PREPARATION_TRIANGLES + 1) * 3 },
          (_, index) => index % 3
        )
      }
    });
    const chip = {
      label: null,
      detail: '600 mm²',
      verbs: [],
      anchor: 'selection' as const,
      onVerb: vi.fn(),
      operation: {
        title: 'Resize Body',
        phase: 'validating' as const,
        onEditCulprit: vi.fn(),
        onViewDetails: vi.fn(),
        onKeepLastValid: vi.fn(),
        onSelectAllEdges: vi.fn()
      }
    } as unknown as ModelViewerProps['selectionCallout'];
    const chipShown = () =>
      madeLabels.some((element) =>
        element.classList.contains('selection-callout-chip')
      );
    const validating = {
      ...idleProps(),
      bodies: [dense()],
      selectedBodyIds: ['part'],
      selectedTopology: { bodyId: 'part', kind: 'body' },
      selectionCallout: chip,
      pickLabel: false
    } as unknown as ModelViewerProps;
    const view = render(createElement(ModelViewer, validating));
    try {
      expect(chipShown()).toBe(false);
      const committed = [dense()];
      view.rerender(
        createElement(ModelViewer, {
          ...validating,
          bodies: committed,
          selectedBodyIds: [],
          selectedTopology: null,
          selectionCallout: null,
          pickLabel: true
        } as unknown as ModelViewerProps)
      );
      // Still on the validating frame: its chip stays unlit.
      expect(workers).toHaveLength(1);
      expect(chipShown()).toBe(false);
      const { id } = workers[0]!.postMessage.mock.lastCall![0] as {
        id: number;
      };
      act(() =>
        workers[0]!.onmessage?.({
          data: {
            id,
            prepared: committed.map((body) => prepareBody(body as never))
          }
        } as MessageEvent)
      );
      expect(chipShown()).toBe(false);
      // The probe does see a chip the live frame asks for.
      view.rerender(
        createElement(ModelViewer, {
          ...validating,
          bodies: committed,
          pickLabel: true
        } as unknown as ModelViewerProps)
      );
      expect(chipShown()).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it('leaves no key listener behind on the document for a retired viewer', () => {
    // OrbitControls removed its capture keydown listener from the canvas's
    // root node as that read at teardown — after React had detached the
    // canvas — so the document kept one per retired viewer, and through it
    // the viewer's canvas and context.
    const keys = trackKeyListeners();
    try {
      const view = openProjects(6);
      view.unmount();
      expect(gl.state.created).toBe(6);
      expect(keys.live).toEqual([]);
    } finally {
      keys.restore();
    }
  });

  it('releases the context and shadow map of every viewer it retires', () => {
    const view = openProjects(11);
    view.unmount();
    expect(gl.state.created).toBe(11);
    expect(gl.state.disposed).toBe(11);
    // dispose() leaves the context to the garbage collector; it is let go
    // explicitly instead.
    expect(gl.state.contextsLost).toBe(11);
    expect(gl.state.shadowLightsDisposed).toBe(11);
  });

  it('keeps one live canvas through the development double mount', async () => {
    // StrictMode runs the scene effect, its cleanup, and the effect again.
    // The first scene's context is released; the second must stay live.
    const view = render(
      createElement(StrictMode, null, createElement(ModelViewer, idleProps()))
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(view.container.querySelectorAll('canvas')).toHaveLength(1);
    expect(view.container.querySelectorAll('.viewer-label-layer')).toHaveLength(
      1
    );
    expect(gl.state.created).toBe(2);
    expect(gl.state.contextsLost).toBe(1);
    view.unmount();
    expect(gl.state.contextsLost).toBe(2);
  });
});
