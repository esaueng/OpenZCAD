import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReleaseBuild } from './check-release-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Validate before replacing the last prepared bundle. The iPad app ships the
// same immutable Remus artifacts as the web and desktop applications.
checkReleaseBuild({ root, dist: 'apps/web/dist-ipad' });
const destination = resolve(root, 'apps/ipad/Resources/Web');
mkdirSync(dirname(destination), { recursive: true });
rmSync(destination, { recursive: true, force: true });
cpSync(resolve(root, 'apps/web/dist-ipad'), destination, { recursive: true });
console.log('Prepared the verified CAD bundle in apps/ipad/Resources/Web.');
