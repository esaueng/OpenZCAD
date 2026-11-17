import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const test = process.argv.includes('--test');
if (process.argv.slice(2).some((arg) => arg !== '--test')) {
  throw new Error('Usage: node scripts/run-ipad-simulator.mjs [--test]');
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
const inventory = JSON.parse(
  run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  })
);
const name = process.env.OPENZCAD_IPAD_SIMULATOR ?? 'iPad Pro 11-inch (M4)';
const devices = Object.values(inventory.devices)
  .flat()
  .filter((device) => device.name === name && device.isAvailable);
const device =
  devices.find((candidate) => candidate.state === 'Booted') ?? devices[0];
if (!device)
  throw new Error(`Create an available ${name} simulator in Xcode first.`);
run('pnpm', ['prepare:ipad']);
if (device.state !== 'Booted') run('xcrun', ['simctl', 'boot', device.udid]);
run('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
const developerDirectory = run('xcode-select', ['-p'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit']
}).trim();
const simulatorApp = resolve(developerDirectory, 'Applications/Simulator.app');
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
const logPath = resolve(output, test ? 'test.log' : 'build.log');
const log = openSync(logPath, 'w');
try {
  console.log(
    `${test ? 'Testing' : 'Building'} on ${name}. Xcode log: ${logPath}`
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
console.log(`${test ? 'Tests passed' : 'Launched ZCAD Prototype'} on ${name}.`);
