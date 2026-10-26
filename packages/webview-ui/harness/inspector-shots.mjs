/* global document */
/**
 * Screenshots the workflow inspector in isolation (harness/inspector.html) for visual review.
 *
 *   node packages/webview-ui/harness/inspector-shots.mjs [--only=<name substring>] [--themes=dark,light]
 *
 * Output: packages/webview-ui/visual-output/inspector-<name>-<theme>.png
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'visual-output');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const only = arg('only');
const themes = (arg('themes') ?? 'dark,light').split(',');

const SHOTS = [
  { name: 'workflow', scenario: 'default', height: 1180 },
  { name: 'workflow-empty', scenario: 'empty', height: 760 },
  { name: 'agent', scenario: 'default', select: 'implement', height: 1000 },
  { name: 'agent-json', scenario: 'default', select: 'review', height: 1180 },
  { name: 'agent-advanced', scenario: 'default', select: 'review', clicks: ['text:Advanced'], height: 1400 },
  { name: 'console', scenario: 'default', select: 'tests', height: 900 },
  { name: 'loop', scenario: 'default', select: 'review_loop', height: 900 },
  { name: 'loop-add-rule', scenario: 'default', select: 'review_loop', clicks: ['text:Add rule'], height: 980 },
  { name: 'loop-fixed', scenario: 'default', select: 'review_loop', clicks: ['text:Fixed times'], height: 640 },
  { name: 'if', scenario: 'default', select: 'needs_fix', height: 700 },
  { name: 'if-rules', scenario: 'default', select: 'needs_fix', clicks: ['text:Rules'], height: 820 },
  { name: 'value-select', scenario: 'default', select: 'review_loop', clicks: ['[aria-label="Rule 1 value"]'], height: 900 },
  { name: 'variables', scenario: 'default', select: 'review', clicks: ['[aria-label="Insert variable"]'], height: 900 },
  { name: 'invalid', scenario: 'invalid', select: 'implement', height: 900 },
  { name: 'running', scenario: 'running', height: 900 },
  { name: 'running-agent', scenario: 'running', select: 'review', height: 900 },
  { name: 'running-summary', scenario: 'running', select: '', height: 900 },
  { name: 'failed', scenario: 'failed', height: 900 },
  { name: 'failed-agent', scenario: 'failed', select: 'review', height: 1000 },
  { name: 'failed-summary', scenario: 'failed', select: '', height: 1000 },
  { name: 'approval', scenario: 'approval', select: 'ship_it', height: 760 },
];

const shots = SHOTS.filter((s) => !only || s.name.includes(only));

await mkdir(outDir, { recursive: true });
const server = await createServer({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  server: { port: 0, strictPort: false },
  logLevel: 'error',
});
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const errors = [];

try {
  for (const shot of shots) {
    for (const theme of themes) {
      const page = await browser.newPage({ viewport: { width: 440, height: shot.height }, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => errors.push(`${shot.name}/${theme}: ${e.message}`));
      page.on('console', (m) => m.type() === 'error' && errors.push(`${shot.name}/${theme}: ${m.text()}`));
      const query = new URLSearchParams({ scenario: shot.scenario, theme });
      if (shot.select !== undefined) query.set('select', shot.select);
      for (const click of shot.clicks ?? []) query.append('click', click);
      await page.goto(`${base}harness/inspector.html?${query}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('body[data-inspector-ready="true"]', { timeout: 15000 }).catch(() => {
        errors.push(`${shot.name}/${theme}: inspector harness never became ready`);
      });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);
      const file = resolve(outDir, `inspector-${shot.name}-${theme}.png`);
      await page.screenshot({ path: file });
      console.log(`✓ ${file}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

if (errors.length) {
  console.error('\nPage errors:\n' + errors.join('\n'));
  process.exitCode = 1;
}
