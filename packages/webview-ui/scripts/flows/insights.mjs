/**
 * Flows for time and tokens per block, capability badges, "Test model" and the setup check (Package A, ui-insights).
 * Loaded by scripts/interactions.mjs, which passes its assertion helpers.
 */
export default function insightsFlows({ check, checkEqual, until, lowContrast, unnamedControls }) {
  const flows = [];
  const flow = (name, options, run) => flows.push({ name, options, run });

  /* ---- sidebar ---- */

  flow(
    'insights: check setup shows the report, a fix posts its message, close dismisses it',
    { view: 'sidebar', scenario: 'default', width: 340, height: 900 },
    async (h) => {
      const { page } = h;
      await page.getByRole('button', { name: 'Check setup' }).click();
      await until(async () => (await h.posted('checkSetup')).length === 1, 'Check setup posts checkSetup');
      const card = page.getByRole('region', { name: 'Setup check' });
      await until(() => card.getByText('Checking…').isVisible(), 'the card shows the running check');
      await until(
        () => card.getByText(/^\d+ problems?$/).isVisible(),
        'the finished check counts the problems',
      );
      const results = card.getByRole('list', { name: 'Setup check results' });
      check((await results.getByRole('listitem').count()) >= 3, 'the report lists endpoints and models');

      await results.getByRole('button', { name: 'Edit endpoint' }).click();
      checkEqual(
        await h.posted('editProvider'),
        [{ type: 'editProvider', providerId: 'ollama' }],
        'the fix posts its message as it is',
      );

      await card.getByRole('button', { name: 'Close setup check' }).click();
      await until(
        async () => (await h.posted('dismissSetupCheck')).length === 1,
        'Close posts dismissSetupCheck',
      );
      await until(async () => !(await card.count()), 'the card goes away');
    },
  );

  flow(
    'insights: a provider row tests the models of its endpoint',
    { view: 'sidebar', scenario: 'default', width: 340, height: 900 },
    async (h) => {
      const { page } = h;
      const row = page.getByRole('button', { name: /LiteLLM.*models/ });
      await row.hover();
      await page.getByRole('button', { name: 'Test models of LiteLLM (localhost:4000)' }).click();
      checkEqual(
        await h.posted('testModel'),
        [{ type: 'testModel', providerId: 'litellm' }],
        'the row posts testModel with its provider',
      );
    },
  );

  flow(
    'insights: agent rows name what each agent may do',
    { view: 'sidebar', scenario: 'default', width: 340, height: 900 },
    async (h) => {
      const { page } = h;
      const coder = page.getByRole('button', { name: /^Coder/ });
      check(await coder.getByText('Edits files (auto)').isVisible(), 'Coder edits files without asking');
      check(await coder.getByText('Runs commands (asks)').isVisible(), 'Coder asks before commands');
      const reviewer = page.getByRole('button', { name: /^Reviewer/ });
      check(await reviewer.getByText('Read-only').isVisible(), 'the reviewer is read-only');
      checkEqual(
        await reviewer.locator('.if-chip', { hasText: 'Read-only' }).getAttribute('title'),
        'Can look at files but not change them or run commands.',
        'the badge explains itself',
      );
    },
  );

  flow(
    'insights: the Blank starter recommends Coder for agents that change code',
    { view: 'sidebar', scenario: 'default', width: 240, height: 900 },
    async (h) => {
      const { page } = h;
      await page.getByRole('button', { name: 'New agent' }).click();
      await page.getByRole('button', { name: 'For an agent that should change code, pick Coder.' }).click();
      check(
        (await page.getByRole('radio', { name: 'Coder' }).getAttribute('aria-checked')) === 'true',
        'Coder is the starter now',
      );
      checkEqual(await h.focused(), 'Coder', 'focus moves to the chosen starter');
    },
  );

  flow(
    'insights: Run again keeps the focus while the check runs',
    { view: 'sidebar', scenario: 'setup', width: 340, height: 1100 },
    async (h) => {
      const { page } = h;
      const card = page.getByRole('region', { name: 'Setup check' });
      await card.getByRole('button', { name: 'Run again' }).focus();
      await page.keyboard.press('Enter');
      await until(async () => (await h.posted('checkSetup')).length === 1, 'Enter runs the check again');
      await until(() => card.getByText('Checking…').isVisible(), 'the card shows the running check');
      checkEqual(await h.focused(), 'Run again', 'the button keeps the focus while it waits');
      await page.keyboard.press('Enter');
      await until(() => card.getByText(/^\d+ problems?$/).isVisible(), 'the check finishes');
      checkEqual(
        await h.posted('checkSetup'),
        [{ type: 'checkSetup' }],
        'a press while it runs does nothing',
      );
      checkEqual(await h.focused(), 'Run again', 'the focus is still there');
    },
  );

  /* ---- agent editor ---- */

  flow('insights: Test model keeps the focus while it tests', { view: 'agent' }, async (h) => {
    const { page } = h;
    await page.getByRole('button', { name: 'Test model' }).focus();
    await page.keyboard.press('Enter');
    await until(
      async () => (await h.focused()) === 'Testing…',
      'the pressed button says Testing… and has the focus',
    );
    await page.keyboard.press('Enter');
    await until(async () => (await h.focused()) === 'Test model', 'the button is ready again with the focus');
    checkEqual((await h.posted('testModel')).length, 1, 'a press while it tests does nothing');
  });

  flow(
    'insights: the header badges follow the tools and permissions',
    { view: 'agent', width: 1280, height: 900 },
    async (h) => {
      const { page } = h;
      const header = page.locator('.ag-header');
      check(
        await header.getByText('Read-only', { exact: true }).isVisible(),
        'the reviewer starts read-only',
      );
      await page.locator('.if-check', { hasText: 'Edit files' }).click();
      await until(async () => /tools: \[.*editFile/.test(await h.agentYaml()), 'the tool is added');
      const always = page
        .locator('.ag-permission', { hasText: 'Edit files' })
        .getByRole('radio', { name: 'Always' });
      await until(async () => !(await always.isDisabled()), 'the permission can be set');
      await always.click();
      await until(
        () => header.getByText('Edits files (auto)', { exact: true }).isVisible(),
        'the header says it edits files without asking',
      );
      check((await header.getByText('Read-only', { exact: true }).count()) === 0, 'Read-only is gone');
      await page
        .locator('.ag-permission', { hasText: 'Edit files' })
        .getByRole('radio', { name: 'Ask' })
        .click();
      await until(
        () => header.getByText('Edits files (asks)', { exact: true }).isVisible(),
        'and follows the next change',
      );
    },
  );

  flow('insights: Test model shows the result in the agent editor', { view: 'agent' }, async (h) => {
    const { page } = h;
    await page.getByRole('button', { name: 'Test model' }).click();
    checkEqual(
      await h.posted('testModel'),
      [{ type: 'testModel', ref: 'vscode/copilot/gpt-4.1' }],
      'the button posts the main model',
    );
    await until(
      async () => (await page.getByRole('button', { name: 'Testing…' }).count()) === 1,
      'the button says Testing… and waits',
    );
    const result = page.locator('.ag-probe');
    await until(async () => (await result.textContent())?.includes('Tool calls work'), 'the result appears');
    check((await result.textContent()).includes('820 ms'), 'the result names how long the test took');
    check(await page.getByRole('button', { name: 'Test model' }).isEnabled(), 'the button is ready again');
  });

  flow('insights: Tool calls writes toolMode to the YAML', { view: 'agent' }, async (h) => {
    const { page } = h;
    await page.getByRole('button', { name: /^Tool calls/ }).click();
    await page.getByRole('option', { name: 'Text in the prompt' }).click();
    await until(async () => (await h.agentYaml()).includes('toolMode: text'), 'toolMode: text is written');
    await page.getByRole('button', { name: /^Tool calls/ }).click();
    await page.getByRole('option', { name: 'Automatic' }).click();
    await until(async () => !(await h.agentYaml()).includes('toolMode'), 'Automatic removes toolMode');
  });

  flow(
    'insights: the probed model explains how Automatic copes',
    { view: 'agent', scenario: 'probed' },
    async (h) => {
      const { page } = h;
      check(
        await page
          .getByText("This model can't call tools natively, so Automatic describes the tools in the prompt.")
          .isVisible(),
        'the note explains text tool mode',
      );
      check(
        await page.locator('.ag-probe', { hasText: 'Needs text tool mode' }).isVisible(),
        'the probe result shows',
      );
    },
  );

  /* ---- workflow editor ---- */

  flow(
    'insights: a run summary row selects its block',
    { view: 'workflow', scenario: 'metrics' },
    async (h) => {
      const { page } = h;
      const table = page.getByRole('table', { name: 'Blocks in this run' });
      await until(() => table.isVisible(), 'the run summary shows the blocks table');
      await table.getByRole('button', { name: /^tests:/ }).click();
      await until(
        async () => (await h.card('tests').getAttribute('aria-pressed')) === 'true',
        'the tests card is selected',
      );
      check(
        await page.getByRole('tab', { name: /Run output/ }).isVisible(),
        'the inspector shows its run output',
      );
    },
  );

  flow(
    'insights: finished cards show time and tokens',
    { view: 'workflow', scenario: 'metrics' },
    async (h) => {
      const metrics = h.card('implement').locator('.wf-card__metrics');
      await until(() => metrics.isVisible(), 'the agent card has a metrics row');
      const text = await metrics.textContent();
      check(/\d/.test(text) && text.includes('tokens'), `the row names time and tokens (got "${text}")`);
      check(!text.includes('·'), 'the parts are separate spans, not a dotted string');
    },
  );

  flow(
    "insights: a new run replaces the shown run's numbers and review with its own",
    { view: 'workflow', scenario: 'review', timeout: 90_000 },
    async (h) => {
      const { page } = h;
      const review = page.getByRole('region', { name: 'Review changes' });
      const metricsOf = (id) => h.card(id).locator('.wf-card__metrics');
      await until(() => review.isVisible(), 'the review of the shown run');
      check(await metricsOf('tests').isVisible(), 'and its numbers on the cards');

      await page.getByRole('button', { name: 'Run', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Run Review until approved' });
      await dialog.getByLabel('task').fill('Add voucher codes');
      await dialog.getByRole('button', { name: 'Run workflow' }).click();
      await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
      await until(async () => (await review.count()) === 0, 'the old review goes away');
      check(
        (await metricsOf('tests').count()) === 0,
        'blocks the new run has not reached show no old numbers',
      );

      await until(
        async () =>
          (
            await page
              .locator('.wf-marker__outcome')
              .innerText()
              .catch(() => '')
          ).includes('Succeeded'),
        'the run succeeds',
        60_000,
      );
      await until(() => review.isVisible(), 'the new run brings its own review');
      checkEqual(
        await review.getByRole('heading').innerText(),
        '2 files changed',
        'it lists what the new run changed',
      );
      check(await review.getByText('2 to review').isVisible(), 'both files wait');
      for (const id of ['implement', 'tests', 'review'])
        check(await metricsOf(id).isVisible(), `${id} shows the numbers of the new run`);
      const table = page.getByRole('table', { name: 'Blocks in this run' });
      check(await table.isVisible(), 'the run summary lists the blocks');
      await page.locator('.wf-runs').click();
      const newest = page.getByRole('menu', { name: 'Runs' }).getByRole('menuitem').first();
      await until(async () => (await newest.innerText()).includes('2 to review'), 'the Runs menu counts it');
      await page.keyboard.press('Escape');
    },
  );

  /* ---- contrast and names of the new states ---- */

  // [view, scenario, width, name, act]: `act` brings a state into view that the scenario does not open itself.
  const scenarios = [
    ['workflow', 'metrics', 1440],
    ['workflow', 'metrics', 900],
    [
      'workflow',
      'metrics',
      1440,
      'output',
      (page) => page.locator('[data-wf-card][data-step-id="review"]').click(),
    ],
    ['sidebar', 'setup', 340],
    ['sidebar', 'narrow-setup', 240],
    ['sidebar', 'setuprunning', 340],
    [
      'sidebar',
      'narrow-newagent',
      240,
      'blank',
      (page) => page.getByRole('radio', { name: 'Blank' }).click(),
    ],
    ['agent', 'probed', 1280],
    ['agent', 'textmode', 1280],
  ];
  const label = ([view, scenario, width, name]) => `${view} ${scenario}${name ? ` ${name}` : ''} ${width}`;
  for (const theme of ['dark', 'light', 'hc', 'hcl']) {
    for (const entry of scenarios) {
      const [view, scenario, width, , act] = entry;
      flow(
        `insights contrast: ${label(entry)} (${theme})`,
        { view, scenario, theme, width, height: 1100 },
        async (h) => {
          if (act) await act(h.page);
          const low = await lowContrast(h.page, 4.5);
          check(
            low.length === 0,
            `text below 4.5:1 (3:1 when large):\n      ${low.slice(0, 12).join('\n      ')}`,
          );
        },
      );
    }
  }
  for (const entry of scenarios) {
    const [view, scenario, width, , act] = entry;
    flow(`insights names: ${label(entry)}`, { view, scenario, width, height: 1100 }, async (h) => {
      if (act) await act(h.page);
      const bad = await unnamedControls(h.page);
      check(bad.length === 0, `unnamed controls: ${[...new Set(bad)].join(', ')}`);
    });
  }

  return flows;
}
