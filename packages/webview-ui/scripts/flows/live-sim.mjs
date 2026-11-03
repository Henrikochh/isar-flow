/* global window, document */
/**
 * Flows of live values and the inspector's Simulation section (Package B, ui-live-sim). Loaded by
 * scripts/interactions.mjs: `--only=live-sim`.
 */
export default function liveSimFlows({ check, checkEqual, until, pause, lowContrast, unnamedControls }) {
  const flows = [];
  const flow = (name, options, run) => flows.push({ name: `live-sim: ${name}`, options, run });

  const inspector = (h) => h.page.locator('.wf-inspector');
  const call = (h, n) => inspector(h).getByRole('group', { name: `Call ${n}` });
  const mocks = (h) => h.posted('setSimulationMocks');
  const simulationText = (h) => h.page.evaluate(() => window.__harness.probe.simulationText?.() ?? '');
  /** Accessible name of the focused control: its aria-label, its label, else its text. */
  const focused = (h) =>
    h.page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return 'body';
      return (
        el.getAttribute('aria-label') ??
        el.labels?.[0]?.textContent?.trim() ??
        el.textContent?.trim().slice(0, 40) ??
        el.tagName
      );
    });
  const token = (h, stepId, expression) =>
    h.card(stepId).locator('.wf-expr', { hasText: expression }).first();

  /* ---- live values ---- */

  flow('hovering a card template shows its value', { view: 'workflow', scenario: 'live' }, async (h) => {
    const { page } = h;
    const task = token(h, 'review', 'inputs.task');
    await task.hover();
    const tip = page.getByRole('tooltip');
    await until(() => tip.isVisible(), 'the value card opens after a short pause');
    check((await tip.textContent()).includes('Last run'), 'it names the last run');
    check(
      (await tip.locator('pre').textContent()).trim().length > 0,
      'it shows the value of inputs.task in that run',
    );
    // Moving onto the card keeps it open; moving away closes it.
    await tip.hover();
    await pause(300);
    check(await tip.isVisible(), 'the card stays while the pointer is on it');
    await page.mouse.move(5, 500);
    await until(async () => !(await tip.count()), 'leaving closes the card');

    await task.hover();
    await until(() => tip.isVisible(), 'the card opens again');
    await page.keyboard.press('Escape');
    await until(async () => !(await tip.count()), 'Escape closes the card');

    // A loop condition the last run checked shows its result on the canvas.
    check(
      await page
        .locator('[aria-label="Loop review_loop"] .wf-loop__head')
        .getByText(/^Last run: /)
        .isVisible(),
      'the loop header shows the last result of its condition',
    );
    check(
      await h
        .card('needs_fix')
        .getByText(/^Last run: /)
        .isVisible(),
      'the If header shows the last result of its condition',
    );
  });

  flow(
    'values from a simulation never read as a real run',
    { view: 'workflow', scenario: 'runs-markers' },
    async (h) => {
      const { page } = h;
      await until(
        () =>
          h
            .card('needs_fix')
            .getByText(/^Last simulation: /)
            .isVisible(),
        'the If header names the simulation',
      );
      checkEqual(await page.getByText(/^Last run: /).count(), 0, 'nothing says Last run');
      await token(h, 'review', 'inputs.task').hover();
      const tip = page.getByRole('tooltip');
      await until(() => tip.isVisible(), 'the value card opens');
      check(await tip.getByText('Last simulation').isVisible(), 'the value card names the simulation');
      await page.keyboard.press('Escape');
      await h.card('fix').click();
      check(
        await inspector(h)
          .getByRole('button', { name: /^Values from the last simulation/ })
          .isVisible(),
        'the inspector names the simulation',
      );
    },
  );

  flow(
    'a long value is cut at 2 KB, says so and fits the window',
    { view: 'workflow', scenario: 'live-long', width: 900, height: 800 },
    async (h) => {
      const { page } = h;
      await token(h, 'review', 'inputs.task').hover();
      const tip = page.getByRole('tooltip');
      await until(() => tip.isVisible(), 'the value card opens');
      check(await tip.getByText('Showing the first 2 KB.').isVisible(), 'it says the value is cut');
      const value = tip.locator('pre');
      const text = await value.textContent();
      check(text.startsWith('Add voucher codes to the checkout.'), 'the value starts at the beginning');
      check(text.length <= 2048, `at most 2,048 characters are shown (got ${text.length})`);
      const box = await tip.boundingBox();
      const view = page.viewportSize();
      check(
        box.y >= 0 && box.x >= 0 && box.y + box.height <= view.height && box.x + box.width <= view.width,
        `the card stays inside the window (${JSON.stringify(box)})`,
      );
      const scrolls = await value.evaluate((el) => el.scrollHeight > el.clientHeight);
      check(scrolls, 'the long value scrolls inside the card');
      // The pointer can reach the card and scroll the value without the card closing.
      await value.hover();
      await page.mouse.wheel(0, 200);
      await pause(250);
      check(await tip.isVisible(), 'scrolling the value keeps the card open');
      check(await value.evaluate((el) => el.scrollTop > 0), 'the value scrolled');
    },
  );

  flow('cards stay single tab stops with live values', { view: 'workflow', scenario: 'live' }, async (h) => {
    const { page } = h;
    await h.card('implement').focus();
    await page.keyboard.press('Tab');
    check(
      (await page.evaluate(() => document.activeElement?.classList.contains('wf-expr'))) === false,
      'Tab never stops on a template token',
    );
    checkEqual(await page.locator('.wf-expr[tabindex]').count(), 0, 'tokens are not focusable');
  });

  flow(
    'the inspector lists template values and copies one',
    { view: 'workflow', scenario: 'live' },
    async (h) => {
      await h.card('fix').click();
      const toggle = inspector(h).getByRole('button', { name: 'Values from the last run (3)' });
      await toggle.click();
      checkEqual(await toggle.getAttribute('aria-expanded'), 'true', 'the list opens');
      const list = inspector(h).getByRole('list', { name: 'Values from the last run' });
      checkEqual(await list.getByRole('listitem').count(), 3, 'one row per distinct template');
      const row = list.getByRole('button', { name: /^steps\.tests\.exitCode/ });
      const preview = (await row.locator('.wf-liverow__preview').textContent()).trim();
      await inspector(h).getByRole('button', { name: 'Copy value of steps.tests.exitCode' }).click();
      checkEqual(
        await h.posted('copyToClipboard'),
        [{ type: 'copyToClipboard', text: preview }],
        'Copy posts the value',
      );
      await row.click();
      checkEqual(await row.getAttribute('aria-expanded'), 'true', 'a row opens to the full value');
      check(await list.getByText('Number').isVisible(), 'the full value names its type');
    },
  );

  flow('keyboard-only through the values list', { view: 'workflow', scenario: 'live' }, async (h) => {
    const { page } = h;
    await h.card('fix').click();
    const toggle = inspector(h).getByRole('button', { name: 'Values from the last run (3)' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    checkEqual(await toggle.getAttribute('aria-expanded'), 'true', 'Enter opens the list');
    await page.keyboard.press('Tab');
    check((await focused(h)).startsWith('toJSON'), 'Tab reaches the first row');
    await page.keyboard.press('Space');
    check((await inspector(h).locator('.wf-liverow__detail').count()) === 1, 'Space opens the row');
    await page.keyboard.press('Tab');
    checkEqual(await focused(h), 'Copy value of toJSON(steps.review.json.issues)', 'Tab reaches Copy');
    await page.keyboard.press('Enter');
    checkEqual((await h.posted('copyToClipboard')).length, 1, 'Enter copies');
  });

  /* ---- Simulation section ---- */

  flow(
    'editing an exit code posts the exact mocks',
    { view: 'workflow', scenario: 'simulation-console' },
    async (h) => {
      const code = call(h, 1).getByLabel('Exit code');
      await code.fill('2');
      await code.blur();
      await until(async () => (await mocks(h)).length === 1, 'the edit is sent');
      checkEqual(
        await mocks(h),
        [
          {
            type: 'setSimulationMocks',
            stepId: 'tests',
            results: [
              { exitCode: 2, output: '1 failed' },
              { exitCode: 0, output: '32 passed' },
            ],
          },
        ],
        'the whole list goes to the host',
      );
      await until(async () => (await simulationText(h)).includes('exitCode: 2'), 'the file has the new code');
      checkEqual(await code.inputValue(), '2', 'the field keeps the typed value');
    },
  );

  flow('add, remove and reorder results', { view: 'workflow', scenario: 'simulation-console' }, async (h) => {
    await inspector(h).getByRole('button', { name: 'Add result' }).click();
    await until(async () => (await mocks(h)).length === 1, 'Add result is sent');
    checkEqual((await mocks(h))[0].results.at(-1), {}, 'a new console result uses the defaults');
    check(await call(h, 3).getByText('Repeats').isVisible(), 'the new last result repeats');
    checkEqual(await focused(h), 'Exit code', 'focus moves into the new result');

    await inspector(h).getByRole('button', { name: 'Move call 2 up' }).click();
    await until(async () => (await mocks(h)).length === 2, 'the move is sent');
    checkEqual(
      (await mocks(h))[1].results,
      [{ exitCode: 0, output: '32 passed' }, { exitCode: 1, output: '1 failed' }, {}],
      'the results swap',
    );
    checkEqual(await focused(h), 'Move call 1 down', 'focus stays with the moved result');

    await inspector(h).getByRole('button', { name: 'Remove call 3' }).click();
    await until(async () => (await mocks(h)).length === 3, 'the removal is sent');
    checkEqual((await mocks(h))[2].results.length, 2, 'two results are left');
    await until(
      async () => !(await simulationText(h)).includes('- {}'),
      'the file no longer has the empty result',
    );
  });

  flow('invalid JSON is not sent', { view: 'workflow', scenario: 'simulation' }, async (h) => {
    const answer = call(h, 2).getByLabel('Answer (JSON)');
    await answer.fill('{ "approved": ');
    await answer.blur();
    await pause(500);
    checkEqual(await mocks(h), [], 'nothing is sent');
    check(
      await call(h, 2)
        .getByText(/^Not valid JSON: /)
        .isVisible(),
      'the field says why',
    );
    await answer.fill('{ "approved": true, "issues": ["Rename the voucher hook"] }');
    await answer.blur();
    await until(async () => (await mocks(h)).length === 1, 'valid JSON is sent');
    checkEqual(
      (await mocks(h))[0].results[1],
      { json: { approved: true, issues: ['Rename the voucher hook'] } },
      'the answer is sent as JSON',
    );
  });

  flow(
    'Open simulation file posts openSimulationFile',
    { view: 'workflow', scenario: 'simulation' },
    async (h) => {
      await inspector(h).getByRole('button', { name: 'Open simulation file' }).click();
      checkEqual(await h.posted('openSimulationFile'), [{ type: 'openSimulationFile' }], 'the link posts');
    },
  );

  flow(
    'a broken file blocks editing and offers to open it',
    { view: 'workflow', scenario: 'simulation-broken' },
    async (h) => {
      const banner = inspector(h).getByRole('alert');
      check(
        (await banner.textContent()).includes("The simulation file has errors, so Simulate won't start."),
        'the banner explains it',
      );
      checkEqual(
        await inspector(h).getByRole('button', { name: 'Add result' }).count(),
        0,
        'results are not editable while the file is broken',
      );
      await banner.getByRole('button', { name: 'Open simulation file' }).click();
      checkEqual(await h.posted('openSimulationFile'), [{ type: 'openSimulationFile' }], 'the banner posts');
    },
  );

  flow(
    'keyboard-only through the Simulation section',
    { view: 'workflow', scenario: 'simulation-console' },
    async (h) => {
      const { page } = h;
      await inspector(h)
        .getByRole('button', { name: /^Simulation/ })
        .focus();
      const order = [];
      for (let i = 0; i < 7; i++) {
        await page.keyboard.press('Tab');
        order.push(await focused(h));
      }
      checkEqual(
        order,
        [
          'Move call 1 down',
          'Remove call 1',
          'Fail this call',
          'Exit code',
          'Output',
          'Move call 2 up',
          'Remove call 2',
        ],
        'Tab walks through the first result and into the second',
      );
      // Back to the switch of call 1, then fail it with the keyboard.
      await call(h, 1).getByRole('switch', { name: 'Fail this call' }).focus();
      await page.keyboard.press('Space');
      await until(async () => (await mocks(h)).length === 1, 'Space fails the call');
      checkEqual((await mocks(h))[0].results[0], { error: 'Simulated failure' }, 'with the default message');
      await page.keyboard.press('Tab');
      checkEqual(await focused(h), 'Error message', 'the message comes next');

      await inspector(h).getByRole('button', { name: 'Add result' }).focus();
      await page.keyboard.press('Enter');
      await until(async () => (await mocks(h)).length === 2, 'Enter adds a result');
      checkEqual(await focused(h), 'Exit code', 'focus moves into the new result');
      const bad = await unnamedControls(page);
      checkEqual(bad, [], 'every control has a name');
    },
  );

  /* ---- contrast ---- */

  for (const theme of ['dark', 'light', 'hc', 'hcl']) {
    flow(
      `chips and notes keep contrast (${theme})`,
      { view: 'workflow', scenario: 'live', theme },
      async (h) => {
        const { page } = h;
        await token(h, 'review', 'inputs.task').hover();
        await until(() => page.getByRole('tooltip').isVisible(), 'the value card opens');
        checkEqual(await lowContrast(page, 4.5), [], 'text on the canvas, chips and the value card');
        await page.keyboard.press('Escape');
        await h.card('fix').click();
        await inspector(h).getByRole('button', { name: 'Values from the last run (3)' }).click();
        await inspector(h)
          .getByRole('button', { name: /^steps\.tests\.exitCode/ })
          .click();
        checkEqual(await lowContrast(page, 4.5), [], 'the values list');
      },
    );

    flow(
      `simulated values keep contrast (${theme})`,
      { view: 'workflow', scenario: 'runs-markers', theme },
      async (h) => {
        const { page } = h;
        await token(h, 'review', 'inputs.task').hover();
        await until(() => page.getByRole('tooltip').isVisible(), 'the value card opens');
        checkEqual(await lowContrast(page, 4.5), [], 'simulation chips on the canvas and the value card');
      },
    );

    flow(
      `the Simulation section keeps contrast (${theme})`,
      { view: 'workflow', scenario: 'simulation-errors', theme },
      async (h) => {
        await inspector(h)
          .getByRole('button', { name: /^Simulation/ })
          .scrollIntoViewIfNeeded();
        checkEqual(await lowContrast(h.page, 4.5), [], 'rows, chips, hints and the warning');
      },
    );
  }

  return flows;
}
