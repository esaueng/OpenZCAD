/// <reference lib="webworker" />
/**
 * Module Worker entry: loads the MLS WASM lazily (only when the app starts
 * this Worker) and serves the engine to the page.
 */
import init, * as wasm from '../pkg/openzcad_mls.js';
import { MlsEngine } from './engine';
import { serveEngine } from './protocol';

const ready = init({
  module_or_path: new URL('../pkg/openzcad_mls_bg.wasm', import.meta.url)
}).then(() => new MlsEngine(wasm));

serveEngine(self, ready);
