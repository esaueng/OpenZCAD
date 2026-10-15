import { basename } from 'node:path';
import type { Plugin } from 'vite';

/** Native module maps retain rejected fetch/evaluation promises by URL. */
export function remusTranslatorRetry(): Plugin {
  return {
    name: 'openzcad-remus-translator-retry',
    apply: 'build',
    renderChunk(code, chunk, _options, meta) {
      const declarations: string[] = [];
      for (const pair of [
        {
          source: '/packages/kernel-adapter/src/remus-runtime.ts',
          target: '/remus-wasm-io/remus_wasm_io.js',
          counter: '__openzcadRemusIoImportAttempt',
          query: 'openzcad-io-retry'
        },
        {
          source: '/apps/web/src/lib/textFonts.ts',
          target: '/packages/geometry/src/text/loader.ts',
          counter: '__openzcadFontLoaderImportAttempt',
          query: 'openzcad-font-retry'
        }
      ]) {
        if (!chunk.moduleIds.some((id) => id.endsWith(pair.source))) continue;
        const targets = chunk.dynamicImports.filter((fileName) =>
          meta.chunks[fileName]?.moduleIds.some((id) =>
            id.endsWith(pair.target)
          )
        );
        if (targets.length === 0) continue;
        const { counter, query } = pair;
        if (code.includes(counter))
          this.error(
            'A native import retry counter collides with generated code.'
          );
        let replacements = 0;
        for (const target of targets) {
          const escaped = basename(target).replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&'
          );
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
              return `import(${quote}${path}${quote}+(${counter}++?"?${query}="+${counter}:""))`;
            }
          );
        }
        if (replacements !== targets.length)
          this.error('The native import no longer matches its verified chunk.');
        declarations.push(`let ${counter}=0;`);
      }
      return declarations.length
        ? { code: `${declarations.join('\n')}\n${code}`, map: null }
        : null;
    }
  };
}
