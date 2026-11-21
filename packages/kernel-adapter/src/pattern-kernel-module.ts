// Compiled code may be shared. Each worker still instantiates its own memory,
// imports and kernel state. This module is scoped to one worker and bundle.
let compiled: WebAssembly.Module | undefined;

export function patternKernelModule(): WebAssembly.Module | undefined {
  return compiled;
}

export function rememberPatternKernelModule(module: WebAssembly.Module): void {
  compiled = module;
}
