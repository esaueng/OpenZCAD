#!/usr/bin/env node
/**
 * Fetches the bundled text-feature font set from Google Fonts.
 *
 * The text module ships real Regular / Bold / Italic / BoldItalic files per
 * family — synthetic bold (stroke widening) and synthetic italic (shear)
 * produce wrong letterforms, so every style is a separately designed file.
 *
 * Run from the repo root:
 *   node scripts/fetch-text-fonts.mjs
 *
 * Output: packages/geometry/assets/fonts/<file>.ttf plus a generated
 * LICENSE-<family>.txt built from the font's own name table (copyright,
 * license description, license URL) followed by the verbatim licence body the
 * URL points at. Nothing here is invented: the attribution comes out of the
 * binaries, and an unrecognised licence URL is a hard error rather than an
 * assumption.
 *
 * The script is intentionally not wired into `pnpm build` — font assets are
 * committed, and this only regenerates them.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Old UA so the CSS API answers with `format('truetype')` sources. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 5.1)';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = path.join(ROOT, 'packages/geometry/assets/fonts');

/**
 * Verbatim licence bodies, taken from files already in this repo rather than
 * retyped. Which one a family gets is decided by the licence URL in its own
 * name table — not all Google Fonts families are OFL (Roboto Slab is
 * Apache-2.0), and asserting the wrong licence would be worse than none.
 */
const OFL_SOURCE = path.join(
  ROOT,
  'node_modules/.pnpm/@fontsource+ibm-plex-sans@5.3.0/node_modules/@fontsource/ibm-plex-sans/LICENSE'
);
const APACHE_SOURCE = path.join(ROOT, 'LICENSE');

/** licence URL fragment -> { id, body key }. */
const LICENSE_BY_URL = [
  { match: /scripts\.sil\.org\/OFL|openfontlicense\.org/i, id: 'OFL-1.1', body: 'ofl' },
  { match: /apache\.org\/licenses\/LICENSE-2\.0/i, id: 'Apache-2.0', body: 'apache' }
];

/**
 * family -> { slug, styles }. `styles` lists the styles the family actually
 * publishes; families without a designed italic (Oswald, Roboto Slab) and
 * display faces with a single weight (Pacifico) are declared truthfully
 * instead of being faked with a shear or a stroke widen.
 */
const FAMILIES = [
  { family: 'Inter', slug: 'inter', styles: ['regular', 'bold', 'italic', 'boldItalic'] },
  { family: 'Open Sans', slug: 'open-sans', styles: ['regular', 'bold', 'italic', 'boldItalic'] },
  { family: 'Lora', slug: 'lora', styles: ['regular', 'bold', 'italic', 'boldItalic'] },
  { family: 'Roboto Slab', slug: 'roboto-slab', styles: ['regular', 'bold'] },
  {
    family: 'JetBrains Mono',
    slug: 'jetbrains-mono',
    styles: ['regular', 'bold', 'italic', 'boldItalic']
  },
  { family: 'Oswald', slug: 'oswald', styles: ['regular', 'bold'] },
  { family: 'Pacifico', slug: 'pacifico', styles: ['regular'] }
];

const STYLE_AXES = {
  regular: { italic: 0, weight: 400 },
  bold: { italic: 0, weight: 700 },
  italic: { italic: 1, weight: 400 },
  boldItalic: { italic: 1, weight: 700 }
};

function cssUrl(family, styles) {
  const axes = styles
    .map((style) => STYLE_AXES[style])
    .map((axis) => `${axis.italic},${axis.weight}`)
    .sort();
  const name = encodeURIComponent(family).replace(/%20/g, '+');
  return `https://fonts.googleapis.com/css2?family=${name}:ital,wght@${axes.join(';')}`;
}

/** Parses `@font-face` blocks into `{ italic, weight, url }` records. */
function parseFaces(css) {
  const faces = [];
  for (const block of css.split('@font-face')) {
    const style = /font-style:\s*([a-z]+)/.exec(block);
    const weight = /font-weight:\s*(\d+)/.exec(block);
    const src = /src:\s*url\(([^)]+)\)/.exec(block);
    if (!style || !weight || !src) continue;
    faces.push({
      italic: style[1] === 'italic' ? 1 : 0,
      weight: Number(weight[1]),
      url: src[1]
    });
  }
  return faces;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const oflFull = await readFile(OFL_SOURCE, 'utf8');
  const bodies = {
    ofl: oflFull.slice(oflFull.indexOf('-----------')),
    apache: await readFile(APACHE_SOURCE, 'utf8')
  };

  // opentype.js is a dependency of @openzcad/geometry, not of the repo root.
  const opentype = await import(
    path.join(ROOT, 'packages/geometry/node_modules/opentype.js/dist/opentype.mjs')
  );
  const manifest = [];
  const licenses = new Map();

  for (const entry of FAMILIES) {
    const url =
      entry.styles.length === 1 && entry.styles[0] === 'regular'
        ? `https://fonts.googleapis.com/css2?family=${encodeURIComponent(entry.family).replace(/%20/g, '+')}`
        : cssUrl(entry.family, entry.styles);
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`${entry.family}: css2 responded ${res.status}`);
    const faces = parseFaces(await res.text());

    let licenseHeader = null;
    for (const style of entry.styles) {
      const axis = STYLE_AXES[style];
      const face = faces.find((f) => f.italic === axis.italic && f.weight === axis.weight);
      if (!face) {
        throw new Error(`${entry.family}: no ${style} face in css2 response`);
      }
      const bin = await fetch(face.url, { headers: { 'User-Agent': USER_AGENT } });
      if (!bin.ok) throw new Error(`${entry.family} ${style}: ${bin.status}`);
      const bytes = Buffer.from(await bin.arrayBuffer());
      const file = `${entry.slug}-${style.toLowerCase()}.ttf`;
      await writeFile(path.join(OUT_DIR, file), bytes);

      const parsed = opentype.parse(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      );
      // opentype.js 2.x groups the name table by platform
      // (`names.windows` / `names.macintosh` / `names.unicode`), and each
      // record is a language map. Read whatever the binary actually carries.
      const pick = (key) => {
        for (const platform of ['windows', 'macintosh', 'unicode']) {
          const record = parsed.names[platform]?.[key];
          if (!record) continue;
          const value = record.en ?? Object.values(record)[0];
          if (value) return value;
        }
        return '';
      };
      if (!licenseHeader) {
        licenseHeader = {
          copyright: pick('copyright'),
          license: pick('license'),
          licenseURL: pick('licenseURL')
        };
      }
      manifest.push({
        family: entry.family,
        style,
        file,
        bytes: bytes.length,
        unitsPerEm: parsed.unitsPerEm,
        licenseUrl: pick('licenseURL'),
        sourceUrl: face.url
      });
      console.log(`${entry.family} ${style} -> ${file} (${bytes.length} bytes)`);
    }

    const resolved = LICENSE_BY_URL.find((candidate) =>
      candidate.match.test(licenseHeader.licenseURL)
    );
    if (!resolved) {
      throw new Error(
        `${entry.family}: license URL "${licenseHeader.licenseURL}" is not one ` +
          'this script knows how to attribute. Add it to LICENSE_BY_URL with ' +
          'the matching licence body before shipping the binary.'
      );
    }
    licenses.set(entry.slug, resolved.id);
    await writeFile(
      path.join(OUT_DIR, `LICENSE-${entry.slug}.txt`),
      [
        entry.family,
        '',
        'Attribution below is copied verbatim from the font binary name table',
        '(fetched from Google Fonts by scripts/fetch-text-fonts.mjs).',
        '',
        licenseHeader.copyright || '(no copyright record in the font name table)',
        '',
        licenseHeader.license || `Licensed under ${resolved.id}.`,
        '',
        licenseHeader.licenseURL,
        '',
        bodies[resolved.body]
      ].join('\n')
    );
  }

  await writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    `${JSON.stringify(
      {
        licenses: Object.fromEntries(licenses),
        faces: manifest
      },
      null,
      2
    )}\n`
  );
  console.log(`\nWrote ${manifest.length} font files to ${OUT_DIR}`);
  for (const [slug, id] of licenses) {
    console.log(`  ${slug}: ${id}`);
  }
}

await main();
