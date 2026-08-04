import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const port = 4445;
const driverUrl = `http://127.0.0.1:${port}`;
const appBinary = resolve(
  'src-tauri/target/aarch64-apple-darwin/debug/openzcad-desktop'
);
const output = [];
const app = spawn(appBinary, [], {
  env: {
    ...process.env,
    TAURI_WEBDRIVER_PORT: String(port),
    WDIO_EMBEDDED_SERVER: 'true'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
app.stdout.on('data', (chunk) => output.push(chunk.toString()));
app.stderr.on('data', (chunk) => output.push(chunk.toString()));

async function waitForDriver() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${driverUrl}/status`);
      if (response.ok) {
        return;
      }
    } catch {
      // The debug app is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(
    `The embedded macOS WebDriver did not become ready.\n${output.join('')}`
  );
}

async function driverRequest(method, path, body) {
  const response = await fetch(`${driverUrl}${path}`, {
    method,
    headers:
      body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : { value: null };
  if (!response.ok || payload?.value?.error) {
    throw new Error(
      payload?.value?.message ??
        payload?.value?.error ??
        `${method} ${path} returned ${response.status}`
    );
  }
  return payload.value;
}

async function connectToApp() {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await driverRequest('POST', '/session', {
        capabilities: { alwaysMatch: { browserName: 'tauri' } }
      });
      if (!value?.sessionId) {
        throw new Error('The driver returned no session id.');
      }
      return value.sessionId;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
  }
  throw new Error(
    `The WebDriver started but no OpenZCAD window became available: ${lastError}\n${output.join('')}`
  );
}

async function execute(sessionId, script, args = []) {
  return driverRequest('POST', `/session/${sessionId}/execute/sync`, {
    script,
    args
  });
}

async function executeAsync(sessionId, script, args = []) {
  return driverRequest('POST', `/session/${sessionId}/execute/async`, {
    script,
    args
  });
}

async function waitForScript(sessionId, description, script, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await execute(sessionId, script)) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(
    `${description} did not become ready: ${lastError ?? 'timed out'}`
  );
}

async function saveScreenshot(sessionId, fileName) {
  const base64 = await driverRequest('GET', `/session/${sessionId}/screenshot`);
  const png = Buffer.from(base64, 'base64');
  await writeFile(fileName, png);
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
}

const delay = (duration) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, duration));

function vectorDistance(left, right) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

async function readDisplayState(sessionId) {
  return execute(
    sessionId,
    `var canvas = document.querySelector('.viewer-host canvas');
    var rect = canvas.getBoundingClientRect();
    return {
      devicePixelRatio: window.devicePixelRatio,
      cssWidth: rect.width,
      cssHeight: rect.height,
      backingWidth: canvas.width,
      backingHeight: canvas.height
    };`
  );
}

async function setE2EPixelRatio(sessionId, value) {
  await execute(
    sessionId,
    `var canvas = document.querySelector('.viewer-host canvas');
    canvas.dispatchEvent(new CustomEvent('openzcad:e2e-pixel-ratio', {
      detail: { value: arguments[0] }
    }));
    return true;`,
    [value]
  );
  return readDisplayState(sessionId);
}

async function readInputState(sessionId) {
  return execute(
    sessionId,
    `var value = null;
    var canvas = document.querySelector('.viewer-host canvas');
    if (!canvas) return null;
    canvas.dispatchEvent(new CustomEvent('openzcad:e2e-input-state', {
      detail: { resolve: function (next) { value = next; } }
    }));
    return value;`
  );
}

async function readCameraPose(sessionId) {
  return (await readInputState(sessionId))?.camera ?? null;
}

async function waitForCameraChange(
  sessionId,
  description,
  before,
  measure,
  minimum = 0.01
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const latest = await readCameraPose(sessionId);
    if (latest && measure(before, latest) > minimum) {
      return latest;
    }
    await delay(100);
  }
  throw new Error(`${description} did not change the live camera pose.`);
}

async function waitForObliqueCamera(sessionId) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const camera = await readCameraPose(sessionId);
    if (camera) {
      const offset = camera.position.map(
        (coordinate, index) => coordinate - camera.target[index]
      );
      const distance = Math.hypot(...offset);
      if (
        distance > 0 &&
        offset.every((coordinate) => Math.abs(coordinate) / distance > 0.15)
      ) {
        return camera;
      }
    }
    await delay(50);
  }
  throw new Error('The production isometric view did not settle off-axis.');
}

async function dispatchPointer(sessionId, type, init) {
  return execute(
    sessionId,
    `var type = arguments[0];
    var init = arguments[1];
    var canvas = document.querySelector('.viewer-host canvas');
    if (!canvas) throw new Error('The WebGL canvas is unavailable.');
    var event = new PointerEvent(type, Object.assign({
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      isPrimary: true
    }, init));
    return canvas.dispatchEvent(event);`,
    [type, init]
  );
}

async function dispatchControlPointer(sessionId, type, init) {
  return execute(
    sessionId,
    `var value = null;
    var canvas = document.querySelector('.viewer-host canvas');
    if (!canvas) throw new Error('The WebGL canvas is unavailable.');
    canvas.dispatchEvent(new CustomEvent('openzcad:e2e-control-pointer', {
      detail: {
        type: arguments[0],
        init: arguments[1],
        resolve: function (next) { value = next; }
      }
    }));
    return value;`,
    [type, init]
  );
}

async function dispatchControlWheel(sessionId, init) {
  return execute(
    sessionId,
    `var canvas = document.querySelector('.viewer-host canvas');
    if (!canvas) throw new Error('The WebGL canvas is unavailable.');
    var event = new WheelEvent('wheel', Object.assign({
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL
    }, arguments[0]));
    return canvas.dispatchEvent(event);`,
    [init]
  );
}

async function locatePickableEdge(sessionId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const point = await executeAsync(
      sessionId,
      `var done = arguments[arguments.length - 1];
      var canvas = document.querySelector('.viewer-host canvas');
      if (!canvas) return done(null);
      var finished = false;
      var finish = function (value) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        done(value);
      };
      var timer = setTimeout(function () { finish(null); }, 1_000);
      canvas.dispatchEvent(new CustomEvent('openzcad:e2e-locate-edge', {
        detail: { resolve: finish }
      }));`
    );
    if (point) {
      return point;
    }
    await delay(200);
  }
  throw new Error('The exact model did not expose a pickable edge.');
}

let sessionId;
try {
  await waitForDriver();
  sessionId = await connectToApp();

  await waitForScript(
    sessionId,
    'The application body',
    'return Boolean(document.body && document.body.textContent);'
  );
  await execute(
    sessionId,
    `var button = Array.from(document.querySelectorAll('button')).find(
      function (candidate) {
        return candidate.textContent.includes('Mounting Bracket');
      }
    );
    if (button) button.click();
    return Boolean(button);`
  );

  await waitForScript(
    sessionId,
    'The 3D viewport',
    `var viewport = document.querySelector('[aria-label="3D viewport"]');
    return Boolean(viewport && viewport.getBoundingClientRect().width > 0);`
  );
  await waitForScript(
    sessionId,
    'The WebGL canvas',
    `var canvas = document.querySelector('canvas');
    return Boolean(canvas && canvas.width > 0 && canvas.height > 0);`
  );

  await waitForScript(
    sessionId,
    'The exact workspace status',
    `var status = document.querySelector('[aria-label="Workspace status"]');
    return Boolean(status && status.textContent.includes('Exact B-rep'));`
  );
  const statusText = await execute(
    sessionId,
    `return document.querySelector('[aria-label="Workspace status"]')
      .textContent;`
  );
  assert.match(statusText, /Exact B-rep/);
  assert.match(statusText, /warnings\s*0/i);
  assert.match(
    await execute(sessionId, 'return document.body.innerText;'),
    /Mounting Bracket/
  );

  const nativeDisplay = await readDisplayState(sessionId);
  const nativeBackingScale = nativeDisplay.backingWidth / nativeDisplay.cssWidth;
  const expectedNativeScale = Math.min(nativeDisplay.devicePixelRatio, 2);
  assert.ok(
    Math.abs(nativeBackingScale - expectedNativeScale) < 0.02,
    'The WebGL backing width does not match the WKWebView device scale.'
  );
  assert.ok(
    Math.abs(
      nativeDisplay.backingHeight / nativeDisplay.cssHeight -
        expectedNativeScale
    ) < 0.02,
    'The WebGL backing height does not match the WKWebView device scale.'
  );

  // Let a Retina workstation exercise the hosted-runner fallback explicitly.
  if (process.env.OPENZCAD_E2E_FORCE_1X === '1') {
    await setE2EPixelRatio(sessionId, 1);
  }

  // Some hosted macOS runners expose only a 1x virtual display. Keep the
  // native scale assertion, then raise only the E2E renderer backing store so
  // CSS-coordinate hit testing is still exercised against a 2x WebGL canvas.
  let display = await readDisplayState(sessionId);
  if (display.backingWidth / display.cssWidth < 1.98) {
    await setE2EPixelRatio(sessionId, 2);
    await waitForScript(
      sessionId,
      'The 2x WebGL backing scale',
      `var canvas = document.querySelector('.viewer-host canvas');
      var rect = canvas.getBoundingClientRect();
      return Math.abs(canvas.width / rect.width - 2) < 0.02 &&
        Math.abs(canvas.height / rect.height - 2) < 0.02;`
    );
    display = await readDisplayState(sessionId);
  }
  assert.ok(
    Math.abs(display.backingWidth / display.cssWidth - 2) < 0.02 &&
      Math.abs(display.backingHeight / display.cssHeight - 2) < 0.02,
    'The smoke test did not establish a 2x CSS-to-backing-pixel scale.'
  );

  // The embedded driver currently translates W3C pointer actions into
  // MouseEvents. OpenZCAD deliberately routes the viewport with PointerEvents,
  // so inject that WKWebView event family directly and record the real
  // setPointerCapture calls made by the production gesture router.
  await execute(
    sessionId,
    `var canvas = document.querySelector('.viewer-host canvas');
    window.__ozPointerCaptureRequests = [];
    var setPointerCapture = canvas.setPointerCapture.bind(canvas);
    canvas.setPointerCapture = function (pointerId) {
      window.__ozPointerCaptureRequests.push(pointerId);
      return setPointerCapture(pointerId);
    };
    return true;`
  );

  const inputArea = await execute(
    sessionId,
    `var rect = document.querySelector('.viewer-host canvas')
      .getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };`
  );
  await waitForScript(
    sessionId,
    'The camera input probe',
    `var ready = false;
    var canvas = document.querySelector('.viewer-host canvas');
    if (canvas) {
      canvas.dispatchEvent(new CustomEvent('openzcad:e2e-input-state', {
        detail: { resolve: function () { ready = true; } }
      }));
    }
    return ready;`
  );
  await execute(
    sessionId,
    `document.querySelector('button[aria-label="Standard views"]').click();
    return true;`
  );
  await waitForScript(
    sessionId,
    'The isometric view control',
    `return Boolean(document.querySelector('button[aria-label="Isometric view (4)"]'));`
  );
  await execute(
    sessionId,
    `document.querySelector('button[aria-label="Isometric view (4)"]').click();
    return true;`
  );
  await waitForObliqueCamera(sessionId);
  const gestureStart = {
    x: inputArea.left + inputArea.width * 0.62,
    y: inputArea.top + inputArea.height * 0.48
  };

  // WKWebView reports trackpad press-drags as mouse-like PointerEvents. Shift
  // preserves the app's left-drag orbit contract; secondary drag exercises
  // pan; fine DOM_DELTA_PIXEL wheel packets match two-finger zoom input.
  const inputState = await readInputState(sessionId);
  assert.equal(
    inputState?.controlsEnabled,
    true,
    `OrbitControls is disabled before the native input smoke: ${JSON.stringify(inputState)}`
  );
  assert.equal(
    inputState?.controlState,
    -1,
    `OrbitControls is not idle before the native input smoke: ${JSON.stringify(inputState)}`
  );
  const beforeOrbit = inputState.camera;
  const orbitDown = await dispatchControlPointer(sessionId, 'pointerdown', {
    pointerId: 403,
    button: 0,
    buttons: 1,
    shiftKey: true,
    clientX: gestureStart.x,
    clientY: gestureStart.y
  });
  assert.equal(
    orbitDown?.controlState,
    0,
    `Shift-drag did not enter the OrbitControls rotate state: ${JSON.stringify(orbitDown)}`
  );
  let orbitMove;
  for (const [deltaX, deltaY] of [
    [20, 8],
    [42, 18],
    [68, 30]
  ]) {
    orbitMove = await dispatchControlPointer(sessionId, 'pointermove', {
      pointerId: 403,
      button: 0,
      buttons: 1,
      shiftKey: true,
      clientX: gestureStart.x + deltaX,
      clientY: gestureStart.y + deltaY
    });
  }
  assert.ok(
    orbitMove &&
      vectorDistance(beforeOrbit.position, orbitMove.camera.position) > 0.1,
    `Shift-drag did not move the live camera during the gesture: ${JSON.stringify({ beforeOrbit, orbitMove })}`
  );
  await dispatchControlPointer(sessionId, 'pointerup', {
    pointerId: 403,
    button: 0,
    buttons: 0,
    shiftKey: true,
    clientX: gestureStart.x + 68,
    clientY: gestureStart.y + 30
  });
  const afterOrbit = await waitForCameraChange(
    sessionId,
    'Shift-drag orbit',
    beforeOrbit,
    (before, after) => vectorDistance(before.position, after.position),
    0.1
  );

  const panDown = await dispatchControlPointer(sessionId, 'pointerdown', {
    pointerId: 404,
    button: 2,
    buttons: 2,
    clientX: gestureStart.x,
    clientY: gestureStart.y
  });
  assert.equal(
    panDown?.controlState,
    2,
    `Secondary drag did not enter the OrbitControls pan state: ${JSON.stringify(panDown)}`
  );
  for (const [deltaX, deltaY] of [
    [18, -6],
    [38, -14],
    [58, -22]
  ]) {
    await dispatchControlPointer(sessionId, 'pointermove', {
      pointerId: 404,
      button: 2,
      buttons: 2,
      clientX: gestureStart.x + deltaX,
      clientY: gestureStart.y + deltaY
    });
  }
  await dispatchControlPointer(sessionId, 'pointerup', {
    pointerId: 404,
    button: 2,
    buttons: 0,
    clientX: gestureStart.x + 58,
    clientY: gestureStart.y - 22
  });
  const afterPan = await waitForCameraChange(
    sessionId,
    'Secondary-drag pan',
    afterOrbit,
    (before, after) => vectorDistance(before.target, after.target),
    0.01
  );

  const distanceBeforeZoom = vectorDistance(afterPan.position, afterPan.target);
  for (let step = 0; step < 8; step += 1) {
    await dispatchControlWheel(sessionId, {
      clientX: gestureStart.x,
      clientY: gestureStart.y,
      deltaX: 0,
      deltaY: -12
    });
    await delay(16);
  }
  const afterZoom = await waitForCameraChange(
    sessionId,
    'Pixel-delta trackpad zoom',
    afterPan,
    (before, after) =>
      Math.abs(
        vectorDistance(before.position, before.target) -
          vectorDistance(after.position, after.target)
      ),
    0.01
  );
  assert.ok(
    vectorDistance(afterZoom.position, afterZoom.target) < distanceBeforeZoom,
    'Negative trackpad deltas did not zoom the camera toward the model.'
  );

  const edge = await locatePickableEdge(sessionId);
  await execute(
    sessionId,
    `var group = document.querySelector('[role="group"][aria-label="Selection filter"]');
    var button = Array.from(group.querySelectorAll('button')).find(
      function (candidate) { return candidate.textContent.trim() === 'Body'; }
    );
    button.click();
    return true;`
  );
  await waitForScript(
    sessionId,
    'The body selection filter',
    `var group = document.querySelector('[role="group"][aria-label="Selection filter"]');
    var button = Array.from(group.querySelectorAll('button')).find(
      function (candidate) { return candidate.textContent.trim() === 'Body'; }
    );
    return button && button.getAttribute('aria-pressed') === 'true';`
  );
  await dispatchPointer(sessionId, 'pointerdown', {
    pointerId: 401,
    button: 0,
    buttons: 1,
    clientX: edge.x,
    clientY: edge.y
  });
  await dispatchPointer(sessionId, 'pointerup', {
    pointerId: 401,
    button: 0,
    buttons: 0,
    clientX: edge.x,
    clientY: edge.y
  });
  await waitForScript(
    sessionId,
    'High-DPI click selection',
    `var label = document.querySelector('.selection-chip-label');
    return Boolean(label && /Mounting Bracket/i.test(label.textContent));`
  );
  assert.ok(
    (
      await execute(
        sessionId,
        'return window.__ozPointerCaptureRequests.slice();'
      )
    ).includes(401),
    'The selection press did not request WKWebView pointer capture.'
  );

  const boxFrom = {
    x: inputArea.left + inputArea.width * 0.88,
    y: inputArea.top + inputArea.height * 0.08
  };
  const boxMid = {
    x: inputArea.left + inputArea.width * 0.45,
    y: inputArea.top + inputArea.height * 0.5
  };
  // Release beyond the canvas edge to prove that the box-selection route still
  // completes after its press requested capture.
  const boxTo = {
    x: inputArea.left - 24,
    y: inputArea.top + inputArea.height * 0.92
  };
  await dispatchPointer(sessionId, 'pointerdown', {
    pointerId: 402,
    button: 0,
    buttons: 1,
    clientX: boxFrom.x,
    clientY: boxFrom.y
  });
  assert.ok(
    (
      await execute(
        sessionId,
        'return window.__ozPointerCaptureRequests.slice();'
      )
    ).includes(402),
    'The box-selection press did not request WKWebView pointer capture.'
  );
  await dispatchPointer(sessionId, 'pointermove', {
    pointerId: 402,
    button: 0,
    buttons: 1,
    clientX: boxMid.x,
    clientY: boxMid.y
  });
  await waitForScript(
    sessionId,
    'The box-selection band',
    `var band = document.querySelector('.selection-band');
    return Boolean(band && !band.hidden && band.getBoundingClientRect().width > 0);`
  );
  await dispatchPointer(sessionId, 'pointermove', {
    pointerId: 402,
    button: 0,
    buttons: 1,
    clientX: boxTo.x,
    clientY: boxTo.y
  });
  await dispatchPointer(sessionId, 'pointerup', {
    pointerId: 402,
    button: 0,
    buttons: 0,
    clientX: boxTo.x,
    clientY: boxTo.y
  });
  await waitForScript(
    sessionId,
    'Box selection',
    `return document.body.innerText.includes('1 body selected');`
  );

  const statusAfterInputs = await execute(
    sessionId,
    `return document.querySelector('[aria-label="Workspace status"]')
      .textContent;`
  );
  assert.equal(
    statusAfterInputs,
    statusText,
    'Viewport input changed the exact document/kernel status.'
  );

  const artifactDir = resolve('artifacts');
  await mkdir(artifactDir, { recursive: true });
  await saveScreenshot(
    sessionId,
    resolve(artifactDir, 'macos-wkwebview-cad.png')
  );
  console.log(
    'WKWebView CAD smoke passed: exact kernel, 2x selection, capture-requested box selection, orbit, pan, and trackpad zoom.'
  );
} finally {
  if (sessionId) {
    const diagnosticDir = resolve('artifacts');
    await mkdir(diagnosticDir, { recursive: true });
    await saveScreenshot(
      sessionId,
      resolve(diagnosticDir, 'macos-wkwebview-last.png')
    ).catch(() => undefined);
    await driverRequest('DELETE', `/session/${sessionId}`).catch(
      () => undefined
    );
  }
  app.kill('SIGTERM');
}
