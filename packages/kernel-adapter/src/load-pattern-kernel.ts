import {
  patternKernelModule,
  rememberPatternKernelModule
} from './pattern-kernel-module';

/** Worker-side loader for the core Remus binary imported by its JS bindings. */
export default async function loadPatternKernel(
  imports: WebAssembly.Imports,
  url: string
): Promise<WebAssembly.Exports> {
  const compiled = patternKernelModule();
  if (compiled) {
    const instance = await WebAssembly.instantiate(compiled, imports);
    return instance.exports;
  }
  const response = await fetch(url);
  const result =
    typeof WebAssembly.instantiateStreaming === 'function' &&
    response.headers.get('Content-Type')?.startsWith('application/wasm')
      ? await WebAssembly.instantiateStreaming(response, imports)
      : await WebAssembly.instantiate(await response.arrayBuffer(), imports);
  rememberPatternKernelModule(result.module);
  return result.instance.exports;
}
