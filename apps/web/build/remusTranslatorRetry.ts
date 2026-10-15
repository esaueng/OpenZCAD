import { basename } from 'node:path';
import type { Plugin } from 'vite';

/** Native module maps retain rejected fetch/evaluation promises by URL. */
export function remusTranslatorRetry(): Plugin {
  return {
    name: 'openzcad-remus-translator-retry',
    apply: 'build',
    renderChunk(code, chunk, _options, meta) {
      if (
        !chunk.moduleIds.some((id) =>
          id.endsWith('/packages/kernel-adapter/src/remus-runtime.ts')
        )
      )
        return null;
      const targets = chunk.dynamicImports.filter((fileName) =>
        meta.chunks[fileName]?.moduleIds.some((id) =>
          id.endsWith('/remus-wasm-io/remus_wasm_io.js')
        )
      );
      if (targets.length === 0) return null;
      const counter = '__openzcadRemusIoImportAttempt';
      if (code.includes(counter))
        this.error(
          'The translator retry counter collides with generated code.'
        );
      let replacements = 0;
      for (const target of targets) {
        const escaped = basename(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const expression = new RegExp(
          `\\bimport\\(\\s*(["'\x60])(\\./${escaped})\\1\\s*\\)`,
          'g'
        );
        code = code.replace(
          expression,
          (_match, quote: string, path: string) => {
            replacements += 1;
            // Emit the declaration and every reference together, before output
            // minification. No source identifier or renamed symbol is assumed.
            return `import(${quote}${path}${quote}+(${counter}++?"?openzcad-io-retry="+${counter}:""))`;
          }
        );
      }
      if (replacements !== targets.length)
        this.error(
          'The translator import no longer matches its verified chunk.'
        );
      return { code: `let ${counter}=0;\n${code}`, map: null };
    }
  };
}
