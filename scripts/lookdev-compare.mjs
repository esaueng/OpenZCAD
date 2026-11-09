#!/usr/bin/env node
/**
 * Builds one self-contained HTML page comparing two sets of viewport
 * look-development captures (U10), written by test/e2e/viewport-lookdev.spec.ts:
 *
 *   node scripts/lookdev-compare.mjs <before-dir> <after-dir> [out.html]
 *
 * Captures are paired by file name. Each pair shows side by side; clicking
 * either image flips both to the other build in place, which is how small
 * shading and edge changes are easiest to see. Images are linked relative to
 * the page rather than embedded (a full set is hundreds of megabytes at
 * device pixel ratio 2), so keep the page beside its capture directories;
 * the default output, `<after-dir>/../comparison.html`, already is.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @param {string} value */
function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** @param {string} dir */
function captures(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.png'))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Pairs the two directories' captures by file name.
 * @param {string[]} before
 * @param {string[]} after
 */
export function pairCaptures(before, after) {
  const names = [...new Set([...before, ...after])].sort((a, b) =>
    a.localeCompare(b)
  );
  return names.map((name) => ({
    name,
    before: before.includes(name),
    after: after.includes(name)
  }));
}

/**
 * @param {{ beforeDir: string, afterDir: string, out: string }} options
 * @returns {string}
 */
export function comparisonPage({ beforeDir, afterDir, out }) {
  const pairs = pairCaptures(captures(beforeDir), captures(afterDir));
  const base = dirname(resolve(out));
  /** @param {string} dir @param {string} name @param {boolean} present */
  const image = (dir, name, present) =>
    present
      ? escapeHtml(
          relative(base, resolve(dir, name))
            .split(sep)
            .map(encodeURIComponent)
            .join('/')
        )
      : '';
  const beforeLabel = escapeHtml(basename(resolve(beforeDir)));
  const afterLabel = escapeHtml(basename(resolve(afterDir)));
  const rows = pairs
    .map(({ name, before, after }) => {
      const a = image(beforeDir, name, before);
      const b = image(afterDir, name, after);
      const cell = (src, label, other, otherLabel) =>
        src
          ? `<figure><img src="${src}" data-a="${src}" data-b="${other}" data-la="${label}" data-lb="${otherLabel}" alt="${escapeHtml(name)} (${label})"><figcaption>${label}</figcaption></figure>`
          : `<figure class="missing"><figcaption>${label}: no capture</figcaption></figure>`;
      return `<section><h2>${escapeHtml(name.replace(/\.png$/, ''))}</h2><div class="pair">${cell(a, beforeLabel, b, afterLabel)}${cell(b, afterLabel, a, beforeLabel)}</div></section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Viewport lookdev comparison</title>
<style>
  :root { color-scheme: dark; --bg: #0e0f12; --ink: #e6e8ec; --muted: #8b919c; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--ink);
    font: 14px/1.4 system-ui, sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { color: var(--muted); margin: 0 0 16px; }
  h2 { font-size: 14px; font-weight: 600; margin: 24px 0 8px; }
  .pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
  figure { margin: 0; }
  img { width: 100%; height: auto; display: block; cursor: pointer; border-radius: 4px; }
  figcaption { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .missing { border: 1px dashed #444; border-radius: 4px; padding: 24px; }
</style>
</head>
<body>
<h1>Viewport lookdev: ${beforeLabel} vs ${afterLabel}</h1>
<p>${pairs.length} captures. Click an image to flip it to the other build.</p>
${rows}
<script>
  for (const img of document.querySelectorAll('img[data-b]')) {
    img.addEventListener('click', () => {
      if (!img.dataset.b) return;
      const flipped = img.dataset.flipped === '1';
      img.src = flipped ? img.dataset.a : img.dataset.b;
      img.nextElementSibling.textContent = flipped ? img.dataset.la : img.dataset.lb;
      img.dataset.flipped = flipped ? '0' : '1';
    });
  }
</script>
</body>
</html>
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [beforeDir, afterDir, out] = process.argv.slice(2);
  if (!beforeDir || !afterDir) {
    console.error(
      'Usage: node scripts/lookdev-compare.mjs <before-dir> <after-dir> [out.html]'
    );
    process.exit(2);
  }
  for (const dir of [beforeDir, afterDir]) {
    if (!existsSync(dir)) {
      console.error(`No capture directory at ${dir}.`);
      process.exit(2);
    }
  }
  const target = resolve(out ?? join(afterDir, '..', 'comparison.html'));
  writeFileSync(target, comparisonPage({ beforeDir, afterDir, out: target }));
  console.log(target);
}
