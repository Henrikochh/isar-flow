/* global document */
/**
 * Screenshots every webview in the browser harness for visual review.
 *
 *   node scripts/visual.mjs                       # all shots, all themes
 *   node scripts/visual.mjs --only=workflow       # views/scenarios containing "workflow"
 *   node scripts/visual.mjs --only=resume,live    # containing any of the comma-separated parts
 *   node scripts/visual.mjs --themes=dark,light
 *
 * Output: packages/webview-ui/visual-output/<view>-<name or scenario>-<theme>.png
 * A shot with `act` interacts with the page (e.g. opens a menu) before the screenshot; `name` tells it apart.
 * Locale and time zone are pinned (en-US, Europe/Zurich) so dates and times read the same on every machine.
 * Every scripts/shots/*.mjs adds shots: its default export is an array shaped like the entries of SHOTS.
 */
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'visual-output');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const only = arg('only')?.split(',').filter(Boolean);
const themes = (arg('themes') ?? 'dark,light,hc').split(',');

const SHOTS = [
  { view: 'sidebar', scenario: 'default', width: 340, height: 820 },
  { view: 'sidebar', scenario: 'workflows', width: 340, height: 820 },
  { view: 'sidebar', scenario: 'empty', width: 340, height: 640 },
  { view: 'sidebar', scenario: 'empty-workflows', width: 340, height: 640 },
  { view: 'sidebar', scenario: 'noworkspace', width: 300, height: 560 },
  { view: 'sidebar', scenario: 'untrusted', width: 340, height: 820 },
  { view: 'sidebar', scenario: 'narrow', width: 240, height: 820 },
  { view: 'sidebar', scenario: 'narrow-workflows', width: 240, height: 820 },
  { view: 'sidebar', scenario: 'wide-running', width: 400, height: 820 },
  { view: 'sidebar', scenario: 'narrow-newagent', width: 240, height: 820 },
  { view: 'sidebar', scenario: 'newworkflow', width: 340, height: 900 },
  { view: 'sidebar', scenario: 'narrow-messy', width: 240, height: 1000 },
  { view: 'sidebar', scenario: 'narrow-messy-workflows', width: 240, height: 820 },
  // Very long agent and workflow names, ids and paths at the narrowest width.
  { view: 'sidebar', scenario: 'narrow-long', width: 240, height: 900 },
  { view: 'sidebar', scenario: 'narrow-long-workflows', width: 240, height: 900 },
  // A simulated and a resumed run on top: their chips in the workflow rows and the recent runs.
  { view: 'sidebar', scenario: 'workflows-markers', width: 340, height: 820 },
  { view: 'sidebar', scenario: 'narrow-workflows-markers', width: 240, height: 820 },
  { view: 'workflow', scenario: 'default', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'selected', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'running', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'failed', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'history', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'noids', width: 1440, height: 900 },
  {
    view: 'workflow',
    scenario: 'default',
    name: 'moveto',
    width: 1440,
    height: 900,
    act: async (page) => {
      await page.click('[data-step-id="tests"]', { button: 'right' });
      await page.getByRole('menuitem', { name: 'Move to…' }).click();
    },
  },
  { view: 'workflow', scenario: 'approval', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'invalid', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'empty', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'condition', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'narrow', width: 900, height: 800 },
  { view: 'workflow', scenario: 'syntax', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'allblocks', width: 1440, height: 1700 },
  { view: 'workflow', scenario: 'long', width: 1440, height: 1500 },
  { view: 'workflow', scenario: 'long-narrow', width: 900, height: 1500 },
  // Loops in loops and in If lanes, an If in an If, an empty loop: eddies, lanes and placeholders together.
  { view: 'workflow', scenario: 'nested', width: 1440, height: 1700 },
  { view: 'workflow', scenario: 'nested-narrow', width: 900, height: 1100 },
  // A finished run of the nested workflow: skipped cards and a skipped If on the canvas, quiet rows in the summary.
  { view: 'workflow', scenario: 'nested-run', width: 1440, height: 1700 },
  { view: 'agent', scenario: 'default', width: 1280, height: 860 },
  { view: 'agent', scenario: 'tryit', width: 1280, height: 860 },
  { view: 'agent', scenario: 'new', width: 1280, height: 860 },
  // A long name, description, model, fallback models and "Used by" paths.
  { view: 'agent', scenario: 'long', width: 1280, height: 860 },
  {
    view: 'agent',
    scenario: 'noperms',
    width: 1280,
    height: 860,
    // Unset permission levels and the "Used by" rows sit below the fold.
    act: (page) => page.getByRole('heading', { name: 'Used by' }).scrollIntoViewIfNeeded(),
  },
];

/** Default exports of scripts/shots/*.mjs in alphabetical order; a missing folder adds nothing. */
async function loadShotFiles() {
  const dir = resolve(here, 'shots');
  const files = await readdir(dir).catch(() => []);
  const extra = [];
  for (const file of files.filter((f) => f.endsWith('.mjs')).sort()) {
    const shots = (await import(pathToFileURL(resolve(dir, file)).href)).default;
    if (!Array.isArray(shots)) throw new Error(`scripts/shots/${file} must export an array of shots`);
    extra.push(...shots);
  }
  return extra;
}

SHOTS.push(...(await loadShotFiles()));

const shotName = (shot) => `${shot.view}-${shot.name ?? shot.scenario}`;
const shots = SHOTS.filter((s) => !only || only.some((part) => shotName(s).includes(part)));

await mkdir(outDir, { recursive: true });
// No file watching: an edit elsewhere in the repo (core is served from source) must not reload a page mid-shot.
const server = await createServer({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  server: { port: 0, strictPort: false, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const errors = [];

try {
  for (const shot of shots) {
    for (const theme of themes) {
      const page = await browser.newPage({
        viewport: { width: shot.width, height: shot.height },
        deviceScaleFactor: 1,
        locale: 'en-US',
        timezoneId: 'Europe/Zurich',
      });
      page.on('pageerror', (e) => errors.push(`${shot.view}/${shot.scenario}/${theme}: ${e.message}`));
      page.on(
        'console',
        (m) => m.type() === 'error' && errors.push(`${shot.view}/${shot.scenario}/${theme}: ${m.text()}`),
      );
      // The sidebar shows relative times; pin the clock just after the fixtures' "now" so they read the same every run.
      if (shot.view === 'sidebar') await page.clock.setFixedTime(new Date(Date.UTC(2026, 9, 26, 9, 30, 20)));
      const url = `${base}harness/index.html?view=${shot.view}&scenario=${shot.scenario}&theme=${theme}&bare=1`;
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForSelector('body[data-harness-ready="true"]', { timeout: 15000 }).catch(() => {});
      await page.evaluate(() =>
        Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))]),
      );
      await page.waitForTimeout(400);
      if (shot.act) {
        await shot.act(page);
        await page.waitForTimeout(300);
      }
      const file = resolve(outDir, `${shotName(shot)}-${theme}.png`);
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
