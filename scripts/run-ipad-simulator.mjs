import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: node scripts/run-ipad-simulator.mjs [--test] [--iphone]';

/** The simulator each device family asks for first. */
export const PREFERRED_SIMULATORS = {
  ipad: 'iPad Pro 11-inch (M4)',
  iphone: 'iPhone 17'
};

export function parseRunnerArguments(argv) {
  const unknown = argv.filter((arg) => arg !== '--test' && arg !== '--iphone');
  if (unknown.length) throw new Error(USAGE);
  return { test: argv.includes('--test'), iphone: argv.includes('--iphone') };
}

/** `'iphone'`, `'ipad'`, or `undefined` for any other simulator. */
export function simulatorFamily(device) {
  const type = device.deviceTypeIdentifier ?? '';
  if (/\.SimDeviceType\.iPhone-/.test(type)) return 'iphone';
  if (/\.SimDeviceType\.iPad-/.test(type)) return 'ipad';
  if (/^iPhone\b/.test(device.name)) return 'iphone';
  if (/^iPad\b/.test(device.name)) return 'ipad';
  return undefined;
}

/** The app's deployment target (`IPHONEOS_DEPLOYMENT_TARGET`). */
export const MINIMUM_IOS = [17, 0, 0];

function runtimeVersion(runtime) {
  const match = /\.SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/.exec(runtime);
  return match ? match.slice(1).map((part) => Number(part ?? 0)) : undefined;
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * Picks the simulator to build on from `xcrun simctl list devices available
 * --json` output. `requested` (OPENZCAD_IPAD_SIMULATOR) names a simulator or
 * its UDID; without it the family's preferred model is used. When the named
 * simulator is not installed, the newest available simulator of the same
 * family stands in, preferring the named model's line and a booted device.
 */
export function chooseSimulator(inventory, { requested, iphone = false } = {}) {
  const devices = Object.entries(inventory.devices).flatMap(
    ([runtime, list]) => {
      const version = runtimeVersion(runtime);
      return version && compareVersions(version, MINIMUM_IOS) >= 0
        ? list
            .filter((device) => device.isAvailable !== false)
            .map((device) => ({ ...device, runtime, version }))
        : [];
    }
  );
  const name = requested || PREFERRED_SIMULATORS[iphone ? 'iphone' : 'ipad'];
  const rank =
    (...lines) =>
    (a, b) =>
      lines.reduce(
        (order, line) =>
          order ||
          Number(b.name.startsWith(line)) - Number(a.name.startsWith(line)),
        0
      ) ||
      // A booted copy is reused, as it may hold the projects under test.
      Number(b.state === 'Booted') - Number(a.state === 'Booted') ||
      compareVersions(b.version, a.version) ||
      a.name.localeCompare(b.name) ||
      a.udid.localeCompare(b.udid);
  const exact = devices
    .filter((device) => device.name === name || device.udid === name)
    .sort(rank(name));
  const named = exact[0];
  const family =
    (named && simulatorFamily(named)) ??
    simulatorFamily({ name }) ??
    (iphone ? 'iphone' : 'ipad');
  if (iphone && family !== 'iphone') {
    throw new Error(
      `--iphone cannot run on ${name}; name an iPhone simulator.`
    );
  }
  if (named) return { device: named, family, fellBack: false };
  // A requested simulator that is gone and names no family (a stale UDID)
  // must not quietly become a different device.
  if (requested && !simulatorFamily({ name: requested })) {
    throw new Error(
      `No available simulator is named or has the UDID ${requested}.`
    );
  }
  // "iPad Pro 11-inch (M4)" → prefer another "iPad Pro 11-inch" first, then
  // the family's preferred line.
  const line = (model) => model.replace(/\s*\([^)]*\)\s*$/, '');
  const [device] = devices
    .filter((candidate) => simulatorFamily(candidate) === family)
    .sort(rank(line(name), line(PREFERRED_SIMULATORS[family])));
  if (!device) {
    throw new Error(
      `No ${family === 'iphone' ? 'iPhone' : 'iPad'} simulator is available. Add one in Xcode › Settings › Components.`
    );
  }
  return { device, family, fellBack: true };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
}

function main() {
  const { test, iphone } = parseRunnerArguments(process.argv.slice(2));
  const inventory = JSON.parse(
    run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit']
    })
  );
  const requested = process.env.OPENZCAD_IPAD_SIMULATOR;
  const { device, family, fellBack } = chooseSimulator(inventory, {
    requested,
    iphone
  });
  const label = `${device.name} (${device.runtime.replace(/^.*\.SimRuntime\./, '')}, ${device.udid})`;
  if (fellBack) {
    const wanted = requested || PREFERRED_SIMULATORS[family];
    console.log(`${wanted} is not installed; using ${label}.`);
  }
  run('pnpm', ['prepare:ipad']);
  if (device.state !== 'Booted') run('xcrun', ['simctl', 'boot', device.udid]);
  run('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
  const developerDirectory = run('xcode-select', ['-p'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  }).trim();
  const simulatorApp = resolve(
    developerDirectory,
    'Applications/Simulator.app'
  );
  if (existsSync(simulatorApp)) {
    run('open', [
      '-a',
      simulatorApp,
      '--args',
      '-CurrentDeviceUDID',
      device.udid
    ]);
  }
  const output = resolve(root, 'artifacts/ipad');
  mkdirSync(output, { recursive: true });
  const logPath = resolve(
    output,
    `${test ? 'test' : 'build'}${family === 'iphone' ? '-iphone' : ''}.log`
  );
  const log = openSync(logPath, 'w');
  try {
    console.log(
      `${test ? 'Testing' : 'Building'} on ${label}. Xcode log: ${logPath}`
    );
    run(
      'xcodebuild',
      [
        '-project',
        'apps/ipad/OpenZCAD.xcodeproj',
        '-scheme',
        'ZCADiPad',
        '-configuration',
        'Debug',
        '-destination',
        `id=${device.udid}`,
        '-derivedDataPath',
        resolve(output, 'DerivedData'),
        '-parallel-testing-enabled',
        'NO',
        'CODE_SIGNING_ALLOWED=NO',
        test ? 'test' : 'build'
      ],
      { stdio: ['ignore', log, log] }
    );
  } finally {
    closeSync(log);
  }
  if (!test) {
    const bundleId = 'app.esau.openzcad.ipad.prototype';
    // Install in place: retain the app's durable local projects and settings.
    run('xcrun', [
      'simctl',
      'install',
      device.udid,
      resolve(
        output,
        'DerivedData/Build/Products/Debug-iphonesimulator/ZCADiPad.app'
      )
    ]);
    run('xcrun', [
      'simctl',
      'launch',
      '--terminate-running-process',
      device.udid,
      bundleId
    ]);
  }
  console.log(
    `${test ? 'Tests passed' : 'Launched ZCAD Prototype'} on ${device.name}.`
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
