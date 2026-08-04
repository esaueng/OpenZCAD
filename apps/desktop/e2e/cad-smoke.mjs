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

async function execute(sessionId, script) {
  return driverRequest('POST', `/session/${sessionId}/execute/sync`, {
    script,
    args: []
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
  await writeFile(fileName, Buffer.from(base64, 'base64'));
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

  const artifactDir = resolve('artifacts');
  await mkdir(artifactDir, { recursive: true });
  await saveScreenshot(
    sessionId,
    resolve(artifactDir, 'macos-wkwebview-cad.png')
  );
  console.log('WKWebView CAD smoke passed: exact kernel, zero warnings.');
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
