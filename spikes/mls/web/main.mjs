// Entry chunk: owns no MLS code. Each library loads lazily inside a module
// Worker, so the WASM never touches the entry bundle or the main thread.
const out = document.getElementById('out');

function runSpike(lib, rounds = 12, scenario = 'main') {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      type: 'module'
    });
    worker.onmessage = (event) => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'worker error'));
    };
    worker.postMessage({ lib, rounds, scenario });
  });
}

window.runSpike = runSpike;
out.textContent = 'Ready. window.runSpike("mls-rs" | "openmls")';

// ?auto=1 runs both libraries and POSTs the results back to the spike
// server, which is how the real Safari run is collected without automation.
if (new URLSearchParams(location.search).has('auto')) {
  const results = [];
  for (const lib of ['mls-rs', 'mls-rs-rustcrypto', 'openmls']) {
    try {
      const main = await runSpike(lib);
      const rejoin = await runSpike(lib, 0, 'rejoin');
      results.push({ ...main, rejoin: rejoin.report?.steps });
    } catch (error) {
      results.push({ lib, error: String(error) });
    }
  }
  out.textContent = JSON.stringify(
    results.map((r) => r.summary ?? r),
    null,
    2
  );
  await fetch('/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userAgent: navigator.userAgent, results })
  });
}
