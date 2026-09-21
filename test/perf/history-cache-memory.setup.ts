// Session runs only: observe exported linear memory without changing WASM.
const memories: WebAssembly.Memory[] = [];
(
  globalThis as unknown as { historyWasmMemories: WebAssembly.Memory[] }
).historyWasmMemories = memories;
const Instance = WebAssembly.Instance;
WebAssembly.Instance = class extends Instance {
  constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
    super(module, imports);
    for (const value of Object.values(this.exports)) {
      if (value instanceof WebAssembly.Memory) memories.push(value);
    }
  }
};
