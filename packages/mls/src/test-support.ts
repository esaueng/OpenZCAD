/**
 * Node-only test helpers: load the committed WASM from disk and run the
 * engine in-process, or behind the Worker protocol on a MessageChannel.
 */
import { readFileSync } from 'node:fs';
import { initSync } from '../pkg/openzcad_mls.js';
import * as wasm from '../pkg/openzcad_mls.js';
import { Mls } from './client';
import { MlsEngine, asyncEngine } from './engine';
import { connectEngine, serveEngine } from './protocol';

let loaded = false;
let memory: WebAssembly.Memory;

/** Observe raw admission allocations without exposing WASM internals publicly. */
export function wasmMemoryForTests(): WebAssembly.Memory {
  loadWasm();
  return memory;
}

export function loadWasm(): typeof wasm {
  if (!loaded) {
    const bytes = readFileSync(
      new URL('../pkg/openzcad_mls_bg.wasm', import.meta.url)
    );
    memory = initSync({ module: bytes }).memory;
    loaded = true;
  }
  return wasm;
}

export function inProcessMls(): Mls {
  return new Mls(asyncEngine(new MlsEngine(loadWasm())));
}

/** The engine behind the same request protocol the Worker serves. */
export function protocolMls(): Mls {
  const channel = new MessageChannel();
  serveEngine(channel.port1, Promise.resolve(new MlsEngine(loadWasm())), {
    insecureTestMethods: true
  });
  channel.port1.start();
  channel.port2.start();
  const connection = connectEngine(channel.port2, {
    insecureTestMethods: true
  });
  return new Mls(connection.api, () => {
    connection.fail('closed');
    channel.port1.close();
    channel.port2.close();
  });
}
