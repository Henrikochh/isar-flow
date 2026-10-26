/* global document */
/**
 * Screenshots every webview in the browser harness for visual review.
 *
 *   node scripts/visual.mjs                       # all shots, all themes
 *   node scripts/visual.mjs --only=workflow       # views/scenarios containing "workflow"
 *   node scripts/visual.mjs --themes=dark,light
 *
 * Output: packages/webview-ui/visual-output/<view>-<scenario>-<theme>.png
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
const themes = (arg('themes') ?? 'dark,light,hc').split(',');

const SHOTS = [
  { view: 'sidebar', scenario: 'default', width: 340, height: 820 },
  { view: 'sidebar', scenario: 'workflows', width: 340, height: 820 },
  { view: 'sidebar', scenario: 'empty', width: 340, height: 640 },
  { view: 'workflow', scenario: 'default', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'selected', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'running', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'failed', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'approval', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'invalid', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'empty', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'condition', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'narrow', width: 900, height: 800 },
  { view: 'agent', scenario: 'default', width: 1280, height: 860 },
  { view: 'agent', scenario: 'tryit', width: 1280, height: 860 },
  { view: 'agent', scenario: 'new', width: 1280, height: 860 },
];

const shots = SHOTS.filter((s) => !only || `${s.view}-${s.scenario}`.includes(only));

await mkdir(outDir, { recursive: true });
const server = await createServer({ root, configFile: resolve(root, 'vite.config.ts'), server: { port: 0, strictPort: false }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const errors = [];

try {
  for (const shot of shots) {
    for (const theme of themes) {
      const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => errors.push(`${shot.view}/${shot.scenario}/${theme}: ${e.message}`));
      page.on('console', (m) => m.type() === 'error' && errors.push(`${shot.view}/${shot.scenario}/${theme}: ${m.text()}`));
      const url = `${base}harness/index.html?view=${shot.view}&scenario=${shot.scenario}&theme=${theme}&bare=1`;
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForSelector('body[data-harness-ready="true"]', { timeout: 15000 }).catch(() => {});
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      const file = resolve(outDir, `${shot.view}-${shot.scenario}-${theme}.png`);
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
