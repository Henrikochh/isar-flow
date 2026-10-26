import fs from 'node:fs';
import path from 'node:path';
import Mocha from 'mocha';

/**
 * Entry point VS Code calls with --extensionTestsPath. Runs the bundled *.test.js files of the suite folder
 * named by ISAR_TEST_SUITE (default 'suite'); ISAR_TEST_GREP filters tests by title.
 */
export function run(): Promise<void> {
  const grep = process.env.ISAR_TEST_GREP;
  const suiteDir = path.join(__dirname, process.env.ISAR_TEST_SUITE || 'suite');
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 60_000, ...(grep && { grep }) });
  const suites = fs
    .readdirSync(suiteDir)
    .filter((file) => file.endsWith('.test.js'))
    .sort();
  for (const file of suites) mocha.addFile(path.join(suiteDir, file));

  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} integration test(s) failed.`)) : resolve(),
    );
  });
}
