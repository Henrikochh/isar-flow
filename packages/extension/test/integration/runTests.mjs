// Runs the integration tests in a real VS Code: builds the suites, copies the fixture workspace to a temp
// folder and starts VS Code with a fresh profile and all other extensions disabled.
//
// VS Code executable: $ISAR_VSCODE_PATH, else a local installation when one is found, else the latest
// stable build downloaded to .vscode-test. Set ISAR_TEST_GREP to run only matching tests, and
// ISAR_EXTENSION_PATH to test another copy of the extension, such as an unpacked .vsix.
import { runTests } from '@vscode/test-electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIntegrationTests } from './build.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testDir, '..', '..');
const fixtureWorkspace = path.join(packageDir, 'test', 'fixtures', 'workspace');
const extensionDevelopmentPath = path.resolve(process.env.ISAR_EXTENSION_PATH || packageDir);

const DOWNLOAD_VERSIONS = new Set(['stable', 'insiders']);

/**
 * A local VS Code installation, if one can be started. On Windows, an installation with a staged background
 * update refuses to start ("Code is currently being updated") until VS Code is restarted, so it is skipped.
 */
function installedVsCode() {
  const candidates = [];
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
    }
    if (process.env.ProgramFiles) {
      candidates.push(path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'));
    }
  } else if (process.platform === 'darwin') {
    // Depending on the release, the app's executable is named Code or Electron.
    const macos = '/Applications/Visual Studio Code.app/Contents/MacOS';
    candidates.push(path.join(macos, 'Code'), path.join(macos, 'Electron'));
  }
  for (const file of candidates.filter((candidate) => fs.existsSync(candidate))) {
    if (fs.existsSync(path.join(path.dirname(file), 'updating_version'))) {
      console.log(`Skipping ${file}: an update is waiting to be installed. Restart VS Code to finish it.`);
      continue;
    }
    return file;
  }
  return undefined;
}

/** ISAR_VSCODE_PATH: an executable, or 'stable' / 'insiders' / a version number to download. */
function vscodeToUse() {
  const configured = process.env.ISAR_VSCODE_PATH?.trim();
  if (configured && (DOWNLOAD_VERSIONS.has(configured) || /^\d+\.\d+\.\d+$/.test(configured))) {
    return { version: configured };
  }
  const executable = configured || installedVsCode();
  return executable ? { vscodeExecutablePath: executable } : { version: 'stable' };
}

const USER_SETTINGS = {
  'telemetry.telemetryLevel': 'off',
  'workbench.startupEditor': 'none',
  'workbench.enableExperiments': false,
  'window.restoreWindows': 'none',
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'update.mode': 'none',
  'git.enabled': false,
};

/** Writes a fresh profile with quiet defaults plus `settings`. */
function createProfile(userDataDir, settings) {
  fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, 'User', 'settings.json'),
    JSON.stringify({ ...USER_SETTINGS, ...settings }, null, 2),
  );
}

async function main() {
  const extensionTestsPath = await buildIntegrationTests();

  const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'isar-flow-it-')));
  const workspace = path.join(tempRoot, 'workspace');
  fs.cpSync(fixtureWorkspace, workspace, { recursive: true });

  const target = vscodeToUse();
  console.log(`VS Code: ${target.vscodeExecutablePath ?? `${target.version} (downloaded to .vscode-test)`}`);
  console.log(`Extension: ${extensionDevelopmentPath}`);
  console.log(`Test workspace: ${workspace}`);

  // Started from a VS Code terminal or task, these make Code.exe act as Node or talk to that window.
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI']) delete process.env[name];

  // Each launch gets its own profile. The fixture workspace turns off command confirmation in its
  // .vscode/settings.json; without a folder, the user settings do it.
  const launches = [
    { name: 'fixture workspace', suite: 'suite', folder: workspace, settings: {} },
    { name: 'window without a folder', suite: 'no-folder', settings: { 'isarFlow.confirmCommands': false } },
  ];
  const failures = [];
  for (const launch of launches) {
    console.log(`\n=== Integration tests: ${launch.name} ===`);
    const profileDir = path.join(tempRoot, launch.suite);
    const userDataDir = path.join(profileDir, 'user-data');
    createProfile(userDataDir, launch.settings);
    try {
      await runTests({
        ...target,
        extensionDevelopmentPath,
        extensionTestsPath,
        extensionTestsEnv: { ISAR_TEST_SUITE: launch.suite },
        launchArgs: [
          ...(launch.folder ? [launch.folder] : []),
          '--disable-extensions',
          `--user-data-dir=${userDataDir}`,
          `--extensions-dir=${path.join(profileDir, 'extensions')}`,
        ],
      });
    } catch (error) {
      failures.push(launch.name);
      console.error(error instanceof Error ? error.message : String(error));
    }
  }

  if (failures.length > 0) {
    console.error(
      `Integration tests failed (${failures.join(', ')}). The workspace and profiles were kept in ${tempRoot}`,
    );
    process.exitCode = 1;
  } else {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      // VS Code helper processes can hold files for a moment after exit; a leftover temp folder is harmless.
      console.warn(`Could not remove ${tempRoot}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

await main();
