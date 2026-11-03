/* global document */
/**
 * Flows of Run from here, the Run / Simulate split button and the run markers (Package B, ui-run). Loaded by
 * scripts/interactions.mjs: `npm run interactions -w @isar-flow/webview-ui -- --only=run-from-here`.
 */
export default ({ check, checkEqual, until, lowContrast, unnamedControls }) => {
  const flows = [];
  const flow = (name, options, run) => flows.push({ name: `run-from-here: ${name}`, options, run });
  const RESUME = { view: 'workflow', scenario: 'resume' };
  const TASK = 'Add voucher codes to the checkout';
  const runsButton = (page) => page.locator('.wf-runs');
  const startMarker = (page) => page.locator('.wf-marker').first();
  const runsLabel = (page) => runsButton(page).innerText();
  const visible = (locator) => async () => (await locator.count()) > 0 && locator.first().isVisible();
  /** The banner over the canvas while a simulated run is shown ("Simulating" or "Simulated run"). */
  const simBanner = (page, name) =>
    page.locator('.wf-banners').getByRole('status', { name: name ?? /^Simulat/ });

  flow(
    'the card menu asks, posts the exact run and the live run reuses earlier blocks',
    RESUME,
    async (h) => {
      const { page } = h;
      await h.card('tests').click({ button: 'right' });
      const items = page.getByRole('menu', { name: 'Block actions' }).getByRole('menuitem');
      checkEqual((await items.first().innerText()).trim(), 'Run from here', 'Run from here comes first');
      await items.first().click();
      const dialog = page.getByRole('dialog', { name: 'Run from tests' });
      await until(visible(dialog), 'the dialog opens');
      checkEqual(await dialog.getByRole('textbox').inputValue(), TASK, 'the inputs of run-3 are filled in');
      check(
        await dialog.getByText('review_loop continues at iteration 5 of 5.').isVisible(),
        'the dialog says where the loop continues',
      );
      await dialog.getByRole('button', { name: 'Run from here' }).click();
      await until(async () => (await h.posted('runFromHere')).length === 1, 'runFromHere is posted');
      checkEqual(
        (await h.posted('runFromHere'))[0],
        { type: 'runFromHere', runId: 'run-3', stepId: 'tests', inputs: { task: TASK } },
        'for run-3 at tests with its inputs',
      );
      await until(visible(h.card('implement').getByText('Reused')), 'implement is marked Reused');
      await until(
        visible(startMarker(page).getByText('Resumed from tests')),
        'the Start marker says where it began',
      );
      check(
        (await h.card('tests').getByText('Reused').count()) === 0,
        'the block it starts at is not reused',
      );
      await until(
        async () => (await runsLabel(page)).includes('Succeeded'),
        'the resumed run finishes',
        20_000,
      );
      check((await runsLabel(page)).includes('Resumed'), 'the Runs button marks the resumed run');
    },
  );

  flow('keyboard only: Shift+F10 on a card runs from here', RESUME, async (h) => {
    const { page } = h;
    await h.card('tests').focus();
    await page.keyboard.press('Shift+F10');
    await until(async () => (await h.focused()) === 'Run from here', 'the menu opens at Run from here');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Run from tests' });
    await until(visible(dialog), 'Enter opens the dialog');
    await until(
      async () => page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'),
      'the input of that run has the focus',
    );
    await page.keyboard.press('Escape');
    await until(async () => (await page.getByRole('dialog').count()) === 0, 'Escape closes the dialog');
    await until(async () => (await h.focused()) === 'tests', 'the focus is back on the card');
    checkEqual(await h.posted('runFromHere'), [], 'nothing runs');

    await page.keyboard.press('Shift+F10');
    await until(async () => (await h.focused()) === 'Run from here', 'the menu opens again');
    await page.keyboard.press('Enter');
    await until(visible(dialog), 'the dialog opens again');
    await until(
      async () => page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'),
      'the input has the focus again',
    );
    await page.keyboard.press('Control+Enter');
    await until(async () => (await h.posted('runFromHere')).length === 1, 'Ctrl+Enter runs from here');
    checkEqual(
      (await h.posted('runFromHere'))[0],
      { type: 'runFromHere', runId: 'run-3', stepId: 'tests', inputs: { task: TASK } },
      'for run-3 at tests',
    );
  });

  flow('Run from tests in the Runs menu shows the failed run and asks', { view: 'workflow' }, async (h) => {
    const { page } = h;
    await runsButton(page).click();
    await page.getByRole('menu', { name: 'Runs' }).getByRole('menuitem', { name: 'Run from tests' }).click();
    await until(
      async () => (await h.posted('selectRun')).some((m) => m.runId === 'run-3'),
      'the failed run-3 is asked for',
    );
    const dialog = page.getByRole('dialog', { name: 'Run from tests' });
    await until(visible(dialog), 'the dialog opens once the run is shown');
    check((await runsLabel(page)).includes('Failed'), 'the canvas shows the failed run');
    await page.keyboard.press('Escape');
    await until(async () => (await page.getByRole('dialog').count()) === 0, 'Escape closes the dialog');
    check(
      await page.evaluate(() => document.activeElement?.classList.contains('wf-runs')),
      'the focus is back on the Runs button',
    );
    checkEqual(await h.posted('runFromHere'), [], 'nothing runs');
  });

  flow(
    'the inspector button opens the dialog with the warnings',
    { view: 'workflow', scenario: 'resume-changed' },
    async (h) => {
      const { page } = h;
      await page.locator('.wf-inspector').getByRole('button', { name: 'Run from here' }).click();
      const dialog = page.getByRole('dialog', { name: 'Run from tests' });
      await until(visible(dialog), 'the dialog opens');
      const warning = dialog.getByRole('status');
      check((await warning.innerText()).includes('Check before running'), 'the warnings have a title');
      check(
        (await warning.innerText()).includes(
          'implement changed since that run, so its result may be outdated.',
        ),
        'the changed block is named',
      );
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await until(async () => (await page.getByRole('dialog').count()) === 0, 'Cancel closes the dialog');
      await until(
        async () => (await h.focused()) === 'Run from here',
        'the focus is back on the inspector button',
      );
      checkEqual(await h.posted('runFromHere'), [], 'nothing runs');
    },
  );

  flow('Simulate from the split menu asks, posts and marks the run', { view: 'workflow' }, async (h) => {
    const { page } = h;
    await page.getByRole('button', { name: 'More run options' }).click();
    await page
      .getByRole('menu', { name: 'Run options' })
      .getByRole('menuitem', { name: /Simulate/ })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Simulate Review until approved' });
    await until(visible(dialog), 'the Simulate dialog opens');
    await dialog.getByRole('textbox').fill('Try the vouchers');
    await dialog.getByRole('button', { name: 'Simulate' }).click();
    await until(async () => (await h.posted('simulate')).length === 1, 'simulate is posted');
    checkEqual(
      (await h.posted('simulate'))[0],
      { type: 'simulate', inputs: { task: 'Try the vouchers' } },
      'with the inputs',
    );
    await until(visible(startMarker(page).getByText('Simulated')), 'the Start marker says Simulated');
    await until(visible(simBanner(page, 'Simulating')), 'a banner over the canvas says it is simulating');
    await until(async () => (await runsLabel(page)).includes('Succeeded'), 'the simulation finishes', 20_000);
    check((await runsLabel(page)).includes('Simulated'), 'the Runs button marks the simulated run');
    await until(visible(simBanner(page, 'Simulated run')), 'the banner says the run was simulated');
    await until(
      visible(
        page
          .locator('.wf-inspector')
          .getByText('Nothing was executed. Results come from the simulation file.'),
      ),
      'the run summary says that nothing ran',
    );
    await simBanner(page, 'Simulated run').getByRole('button', { name: 'Edit mocks' }).click();
    await until(
      async () => (await h.posted('openSimulationFile')).length === 1,
      'Edit mocks in the banner opens the simulation file',
    );
  });

  flow('a real run after a simulation drops every Simulated marker', { view: 'workflow' }, async (h) => {
    const { page } = h;
    await page.getByRole('button', { name: 'More run options' }).click();
    await page
      .getByRole('menu', { name: 'Run options' })
      .getByRole('menuitem', { name: /Simulate/ })
      .click();
    const simulate = page.getByRole('dialog', { name: 'Simulate Review until approved' });
    await simulate.getByRole('textbox').fill('Try first');
    await simulate.getByRole('button', { name: 'Simulate' }).click();
    await until(visible(simBanner(page, 'Simulated run')), 'the simulation finishes', 20_000);

    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const run = page.getByRole('dialog', { name: 'Run Review until approved' });
    await until(visible(run), 'the Run dialog opens');
    checkEqual(await run.getByRole('textbox').inputValue(), 'Try first', 'it remembers the simulated input');
    await run.getByRole('button', { name: 'Run workflow' }).click();
    await until(async () => (await h.posted('run')).length === 1, 'run is posted');
    await until(async () => (await simBanner(page).count()) === 0, 'the simulated banner goes away');
    checkEqual(await startMarker(page).getByText('Simulated').count(), 0, 'the Start marker is plain');
    await until(
      async () => !(await runsLabel(page)).includes('Simulated'),
      'the Runs button no longer says Simulated',
    );
  });

  flow(
    'switching between a simulated and a real past run updates the markers',
    { view: 'workflow', scenario: 'runs-markers' },
    async (h) => {
      const { page } = h;
      const history = () => page.getByRole('menu', { name: 'Runs' }).getByRole('menuitem');
      await runsButton(page).click();
      await history().filter({ hasText: 'Simulated' }).click();
      await until(visible(simBanner(page, 'Simulated run')), 'the simulated run shows the banner');
      check(await startMarker(page).getByText('Simulated').isVisible(), 'and the Start chip');
      await runsButton(page).click();
      await history().filter({ hasText: 'Resumed' }).click();
      await until(async () => (await simBanner(page).count()) === 0, 'a real run shows no banner');
      await until(
        visible(startMarker(page).getByText('Resumed from tests')),
        'the Start marker says where the resumed run began',
      );
      checkEqual(await startMarker(page).getByText('Simulated').count(), 0, 'and no Simulated chip');
    },
  );

  flow(
    'Restricted Mode: Run is off, Simulate works',
    { view: 'workflow', scenario: 'untrusted' },
    async (h) => {
      const { page } = h;
      check(await page.getByRole('button', { name: 'Run', exact: true }).isDisabled(), 'Run is disabled');
      const more = page.getByRole('button', { name: 'More run options' });
      check(await more.isEnabled(), 'the run options stay available');
      await more.click();
      const menu = page.getByRole('menu', { name: 'Run options' });
      checkEqual(
        await menu.getByRole('menuitem').first().getAttribute('aria-disabled'),
        'true',
        'Run in the menu is disabled',
      );
      await menu.getByRole('menuitem', { name: /Simulate/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Simulate Review until approved' });
      await dialog.getByRole('textbox').fill('Untrusted try');
      await dialog.getByRole('button', { name: 'Simulate' }).click();
      await until(async () => (await h.posted('simulate')).length === 1, 'simulate is posted');
      checkEqual(await h.posted('run'), [], 'no real run');
    },
  );

  flow(
    'Restricted Mode: the banner simulates and gets the focus back',
    { view: 'workflow', scenario: 'untrusted' },
    async (h) => {
      const { page } = h;
      const banner = page.locator('.wf-banners .if-banner--warning');
      const simulate = banner.getByRole('button', { name: 'Simulate' });
      await simulate.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Simulate Review until approved' });
      await until(visible(dialog), 'the Simulate dialog opens');
      await until(
        async () => page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'),
        'the input has the focus',
      );
      await page.keyboard.press('Escape');
      await until(async () => (await page.getByRole('dialog').count()) === 0, 'Escape closes it');
      await until(async () => (await h.focused()) === 'Simulate', 'the focus is back on the banner button');
      await simulate.click();
      await dialog.getByRole('textbox').fill('From the banner');
      await dialog.getByRole('button', { name: 'Simulate' }).click();
      await until(async () => (await h.posted('simulate')).length === 1, 'simulate is posted');
      checkEqual(await h.posted('run'), [], 'no real run');
      await until(
        async () => (await simulate.count()) === 0,
        'the banner offers no second simulation while one runs',
      );
    },
  );

  flow('keyboard only: the split menu and the Simulate dialog', { view: 'workflow' }, async (h) => {
    const { page } = h;
    await page.getByRole('button', { name: 'More run options' }).focus();
    await page.keyboard.press('Enter');
    await until(async () => (await h.focused()) === 'Run', 'Enter opens the menu at its first item');
    await page.keyboard.press('Escape');
    await until(async () => (await h.focused()) === 'More run options', 'Escape returns to the menu button');
    await page.keyboard.press('ArrowDown');
    await until(async () => (await h.focused()) === 'Run', 'ArrowDown opens the menu too');
    await page.keyboard.press('ArrowDown');
    await until(async () => (await h.focused()).startsWith('Simulate'), 'ArrowDown moves to Simulate');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Simulate Review until approved' });
    await until(visible(dialog), 'Enter opens the Simulate dialog');
    await until(
      async () => page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'),
      'the first input has the focus',
    );
    await page.keyboard.type('Keyboard task');
    await page.keyboard.press('Control+Enter');
    await until(async () => (await h.posted('simulate')).length === 1, 'Ctrl+Enter simulates');
    checkEqual((await h.posted('simulate'))[0].inputs, { task: 'Keyboard task' }, 'with the typed input');
    await until(async () => (await h.focused()) === 'Stop', 'the focus moves to Stop while it simulates');
    await until(
      async () => (await h.focused()) === 'Run',
      'the focus is back on Run when the simulation ends',
      20_000,
    );
  });

  /* ---- contrast and names of the new chips, notes, menus and dialogs ---- */

  const views = [
    ['resumed', undefined],
    ['simulated', undefined],
    ['runs-markers', 'runs menu', (page) => runsButton(page).click()],
    [
      'resume',
      'card menu',
      (page) => page.click('[data-wf-card][data-step-id="tests"]', { button: 'right' }),
    ],
    [
      'resume-changed',
      'dialog',
      (page) => page.locator('.wf-inspector').getByRole('button', { name: 'Run from here' }).click(),
    ],
    ['untrusted', 'split menu', (page) => page.getByRole('button', { name: 'More run options' }).click()],
  ];
  const label = ([scenario, name]) => `${scenario}${name ? ` ${name}` : ''}`;
  for (const theme of ['dark', 'light', 'hc', 'hcl']) {
    for (const entry of views) {
      const [scenario, , act] = entry;
      flow(`contrast ${label(entry)} (${theme})`, { view: 'workflow', scenario, theme }, async (h) => {
        if (act) await act(h.page);
        await h.page.waitForTimeout(200);
        const low = await lowContrast(h.page, 4.5);
        check(
          low.length === 0,
          `text below 4.5:1 (3:1 when large):\n      ${low.slice(0, 12).join('\n      ')}`,
        );
      });
    }
  }
  for (const entry of views) {
    const [scenario, , act] = entry;
    flow(`names ${label(entry)}`, { view: 'workflow', scenario }, async (h) => {
      if (act) await act(h.page);
      await h.page.waitForTimeout(200);
      const bad = await unnamedControls(h.page);
      check(bad.length === 0, `unnamed controls: ${[...new Set(bad)].join(', ')}`);
    });
  }

  return flows;
};
