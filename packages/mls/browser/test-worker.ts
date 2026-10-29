/// <reference lib="webworker" />
/** Explicitly test-only transport for malicious-sender scenario probes. */
import init, * as wasm from '../pkg/openzcad_mls.js';
import { MlsEngine } from '../src/engine';
import { serveEngine } from '../src/protocol';

const ready = init({
  module_or_path: new URL('../pkg/openzcad_mls_bg.wasm', import.meta.url)
}).then(() => new MlsEngine(wasm));
serveEngine(self, ready, { insecureTestMethods: true });
