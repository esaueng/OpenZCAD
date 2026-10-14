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
import { act, render } from '@testing-library/react';
import type * as Three from 'three';
import type { ModelViewerProps } from './ModelViewer';

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

const { ModelViewer } = await import('./ModelViewer');

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
    rotateRequest: null,
    units: 'mm',
    editableBodyIds: [],
    movePreview: null,
    moveCommitHold: null,
    appearancePreview: null,
    projection: 'perspective',
    initialView: null,
    selectionFilter: 'any',
    offsetHandle: null,
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
  gl.state.created = 0;
  gl.state.disposed = 0;
  gl.state.contextsLost = 0;
  gl.state.shadowLightsDisposed = 0;
});

describe('ModelViewer lifecycle', () => {
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
