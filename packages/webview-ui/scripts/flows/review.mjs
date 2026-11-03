/* global window */
/**
 * Flows of the review card, the run history counts and the isolation settings (loaded by
 * scripts/interactions.mjs): `npm run interactions -w @isar-flow/webview-ui -- --only=review`.
 */
export default ({ check, checkEqual, until, lowContrast, segmentEdges, unnamedControls }) => {
  const flows = [];
  const flow = (name, options, run) => flows.push({ name: `review: ${name}`, options, run });
  const reviewCard = (page) => page.getByRole('region', { name: 'Review changes' });
  const row = (page, path) => reviewCard(page).locator(`li[data-path="${path}"]`);
  const openedDiffs = (page) => page.evaluate(() => window.__harness.probe.openedDiffs?.() ?? []);
  const REVIEW = { view: 'workflow', scenario: 'review' };

  flow('keep one file', REVIEW, async (h) => {
    const { page } = h;
    await reviewCard(page).getByRole('button', { name: 'Keep src/cart.ts' }).click();
    await until(async () => (await h.posted('reviewFiles')).length === 1, 'the decision is sent');
    checkEqual(
      (await h.posted('reviewFiles'))[0],
      { type: 'reviewFiles', runId: 'run-8', decision: 'kept', paths: ['src/cart.ts'] },
      'for that file only',
    );
    await until(
      async () => (await row(page, 'src/cart.ts').getByText('Kept', { exact: true }).count()) === 1,
      'the file shows Kept',
    );
    check(await reviewCard(page).getByText('4 to review').isVisible(), 'four files are left');
    await page.locator('.wf-runs').click();
    const newest = page.getByRole('menu', { name: 'Runs' }).getByRole('menuitem').first();
    await until(async () => (await newest.innerText()).includes('4 to review'), 'the Runs menu counts it');
    await page.keyboard.press('Escape');
  });

  flow('revert one file', REVIEW, async (h) => {
    const { page } = h;
    await reviewCard(page).getByRole('button', { name: 'Revert docs/vouchers.md' }).click();
    await until(async () => (await h.posted('reviewFiles')).length === 1, 'the decision is sent');
    checkEqual(
      (await h.posted('reviewFiles'))[0],
      { type: 'reviewFiles', runId: 'run-8', decision: 'reverted', paths: ['docs/vouchers.md'] },
      'for that file only',
    );
    await until(
      async () => (await row(page, 'docs/vouchers.md').getByText('Reverted', { exact: true }).count()) === 1,
      'the file shows Reverted',
    );
    check(
      (await row(page, 'docs/vouchers.md')
        .getByRole('button', { name: /^(Keep|Revert) / })
        .count()) === 0,
      'its decision buttons are gone',
    );
  });

  flow(
    'a failed revert shows its error and the file stays pending',
    { view: 'workflow', scenario: 'review-journal' },
    async (h) => {
      const { page } = h;
      const file = row(page, 'config/deploy.readonly.json');
      await file.getByRole('button', { name: 'Revert config/deploy.readonly.json' }).click();
      await until(
        async () => (await file.getByText(/the file is read-only/).count()) === 1,
        'the error shows',
      );
      check(
        await file.getByRole('button', { name: 'Keep config/deploy.readonly.json' }).isEnabled(),
        'the file can still be decided',
      );
      check(
        await row(page, 'test/fixtures/catalog-snapshot.json')
          .getByRole('button', { name: 'Revert test/fixtures/catalog-snapshot.json' })
          .isDisabled(),
        'a file without a saved state cannot be reverted',
      );
    },
  );

  flow('keep all folds the card to its summary', REVIEW, async (h) => {
    const { page } = h;
    const card = reviewCard(page);
    await card.getByRole('button', { name: 'Keep all' }).click();
    await until(async () => (await h.posted('reviewFiles')).length === 1, 'the decision is sent');
    checkEqual(
      (await h.posted('reviewFiles'))[0],
      { type: 'reviewFiles', runId: 'run-8', decision: 'kept' },
      'for every pending file',
    );
    await until(
      async () => (await card.getByText('5 kept', { exact: true }).count()) === 1,
      'the summary shows',
    );
    check(await card.getByRole('button', { name: 'Show review' }).isVisible(), 'the card is folded');
    check((await card.getByRole('list', { name: 'Changed files' }).count()) === 0, 'the list is hidden');
    await until(async () => (await h.focused()) === 'Show review', 'the focus stays in the card');
  });

  flow('revert all asks first, with Cancel as the default', REVIEW, async (h) => {
    const { page } = h;
    const card = reviewCard(page);
    await card.getByRole('button', { name: 'Revert all' }).click();
    const question = card.getByRole('group', { name: 'Revert 5 files?' });
    await question.waitFor();
    checkEqual(await h.focused(), 'Cancel', 'Cancel has the focus');
    check(
      (await card.getByRole('button', { name: 'Keep all' }).count()) === 0,
      'Keep all waits for the answer',
    );
    await page.keyboard.press('Escape');
    await until(async () => (await question.count()) === 0, 'Escape closes the question');
    checkEqual(await h.focused(), 'Revert all', 'the focus is back on Revert all');
    checkEqual(await h.posted('reviewFiles'), [], 'nothing is reverted');

    await page.keyboard.press('Enter');
    await question.waitFor();
    await page.keyboard.press('Shift+Tab');
    checkEqual(await h.focused(), 'Revert 5 files', 'Shift+Tab reaches the answer that reverts');
    await page.keyboard.press('Enter');
    await until(async () => (await h.posted('reviewFiles')).length === 1, 'the decision is sent');
    checkEqual(
      (await h.posted('reviewFiles'))[0],
      { type: 'reviewFiles', runId: 'run-8', decision: 'reverted' },
      'for every pending file',
    );
    await until(
      async () => (await card.getByText('5 reverted', { exact: true }).count()) === 1,
      'the summary shows',
    );
    await until(async () => (await h.focused()) === 'Show review', 'the focus stays in the card');
  });

  flow(
    'revert all counts what it can revert and leaves the rest pending',
    { view: 'workflow', scenario: 'review-journal' },
    async (h) => {
      const { page } = h;
      const card = reviewCard(page);
      await card.getByRole('button', { name: 'Revert all' }).click();
      const question = card.getByRole('group', { name: 'Revert 3 files?' });
      await question.waitFor();
      check(
        await question
          .getByText("1 file can't be reverted and stays as it is.", { exact: false })
          .isVisible(),
        'the question names the file that stays',
      );
      await question.getByRole('button', { name: 'Revert 3 files' }).click();
      await until(
        async () =>
          (await row(page, 'config/deploy.readonly.json')
            .getByText(/read-only/)
            .count()) === 1,
        'the failed revert shows its error',
      );
      check(
        (await row(page, 'src/checkout/vouchers.test.ts').getByText('Reverted', { exact: true }).count()) ===
          1,
        'the others are reverted',
      );
      check(await card.getByText('2 to review').isVisible(), 'the file without a saved state still waits');
      check(await card.getByRole('button', { name: 'Keep all' }).isVisible(), 'and can still be kept');
    },
  );

  flow('open diff posts openReviewDiff', REVIEW, async (h) => {
    const { page } = h;
    await reviewCard(page).getByRole('button', { name: 'Open diff of src/cart.ts' }).click();
    await until(async () => (await h.posted('openReviewDiff')).length === 1, 'the request is sent');
    checkEqual(
      (await h.posted('openReviewDiff'))[0],
      { type: 'openReviewDiff', runId: 'run-8', path: 'src/cart.ts' },
      'for that file',
    );
    checkEqual(await openedDiffs(page), [{ runId: 'run-8', path: 'src/cart.ts' }], 'the host got it');
    check(
      (await reviewCard(page).getByRole('button', { name: 'Open diff of assets/logo.png' }).count()) === 0,
      'binary files have no diff',
    );
  });

  flow('a block chip selects the block', REVIEW, async (h) => {
    const { page } = h;
    await row(page, 'src/cart.ts').getByRole('button', { name: 'Select block fix' }).click();
    await until(async () => (await h.card('fix').getAttribute('aria-pressed')) === 'true', 'fix is selected');
    await until(
      async () => (await h.card('fix').isVisible()) && (await h.card('fix').boundingBox()) !== null,
      'it is in view',
    );
  });

  flow('keyboard only: decide, open a diff, fold and unfold', REVIEW, async (h) => {
    const { page } = h;
    await reviewCard(page).getByRole('button', { name: 'Hide review' }).focus();
    await page.keyboard.press('Tab');
    checkEqual(await h.focused(), 'Keep assets/logo.png', 'Tab reaches the first decision (a binary file)');
    await page.keyboard.press('Enter');
    await until(async () => (await h.posted('reviewFiles')).length === 1, 'Enter keeps it');
    await until(async () => (await h.focused()) === 'Keep docs/vouchers.md', 'the next file takes the focus');
    await page.keyboard.press('Shift+Tab');
    checkEqual(await h.focused(), 'Open diff of docs/vouchers.md', 'Shift+Tab reaches its diff');
    await page.keyboard.press('Enter');
    await until(async () => (await h.posted('openReviewDiff')).length === 1, 'Enter opens the diff');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    checkEqual(await h.focused(), 'Revert docs/vouchers.md', 'Tab reaches Revert');
    await page.keyboard.press('Space');
    await until(async () => (await h.posted('reviewFiles')).length === 2, 'Space reverts it');
    await until(
      async () => (await h.focused()) === 'Keep package-lock.json',
      'the next file takes the focus',
    );

    await reviewCard(page).getByRole('button', { name: 'Hide review' }).focus();
    await page.keyboard.press('Enter');
    await until(async () => (await h.focused()) === 'Show review', 'the toggle keeps the focus');
    check(
      (await reviewCard(page).getByRole('list', { name: 'Changed files' }).count()) === 0,
      'the list folds',
    );
    await page.keyboard.press('Space');
    await until(
      async () => (await reviewCard(page).getByRole('list', { name: 'Changed files' }).count()) === 1,
      'and unfolds',
    );
  });

  flow(
    'every control of the card has an accessible name',
    { view: 'workflow', scenario: 'review-journal' },
    async (h) => {
      const bad = await unnamedControls(h.page);
      check(bad.length === 0, `unnamed controls: ${[...new Set(bad)].join(', ')}`);
    },
  );

  flow('the isolation switch writes the YAML', { view: 'workflow' }, async (h) => {
    const { page } = h;
    await page.getByRole('radio', { name: 'Separate worktree' }).click();
    await until(async () => /\nisolation: worktree\n/.test(await h.workflowYaml()), 'isolation is written');
    await page.getByRole('button', { name: 'Add command' }).click();
    const command = page.getByRole('textbox', { name: 'Setup command 1' });
    await command.fill('npm ci');
    await command.press('Tab');
    await until(
      async () => /\nsetup:\n\s+- npm ci\n/.test(await h.workflowYaml()),
      'the setup command is written',
    );
    const yaml = await h.workflowYaml();
    check(
      yaml.indexOf('isolation:') < yaml.indexOf('setup:') && yaml.indexOf('setup:') < yaml.indexOf('steps:'),
      'in canonical order',
    );

    await page.getByRole('radio', { name: 'Workspace' }).click();
    await page.getByText('Switching to Workspace removes them.').waitFor();
    check(/\nsetup:/.test(await h.workflowYaml()), 'nothing is removed before confirming');
    await page.getByRole('button', { name: 'Switch to Workspace' }).click();
    await until(async () => !/\n(isolation|setup):/.test(await h.workflowYaml()), 'both keys are removed');
    check(
      (await page.getByRole('radio', { name: 'Workspace' }).getAttribute('aria-checked')) === 'true',
      'Workspace is selected',
    );
  });

  flow(
    'the Revert all question has named controls',
    { view: 'workflow', scenario: 'review-worktree' },
    async (h) => {
      await reviewCard(h.page).getByRole('button', { name: 'Revert all' }).click();
      await reviewCard(h.page).getByRole('group', { name: 'Revert 3 files?' }).waitFor();
      const bad = await unnamedControls(h.page);
      check(bad.length === 0, `unnamed controls: ${[...new Set(bad)].join(', ')}`);
    },
  );

  // Text contrast and the selected segment's edge in every theme, open and folded cards included.
  const OPEN = 'open';
  const ASK = 'ask';
  for (const theme of ['dark', 'light', 'hc', 'hcl']) {
    for (const [scenario, width, act] of [
      ['review', 1440],
      ['review', 1440, ASK],
      ['review-journal', 1440],
      ['review-worktree', 1440],
      ['review-done', 1440, OPEN],
      ['review-narrow', 900],
      ['review-narrow', 900, ASK],
      ['isolation', 1440],
    ]) {
      flow(
        `contrast in ${scenario}${act === ASK ? ' asking' : ''} (${theme})`,
        { view: 'workflow', scenario, theme, width, height: 900 },
        async (h) => {
          if (act === OPEN) await reviewCard(h.page).getByRole('button', { name: 'Show review' }).click();
          if (act === ASK) {
            await reviewCard(h.page).getByRole('button', { name: 'Revert all' }).click();
            await reviewCard(h.page)
              .getByRole('group', { name: /^Revert \d+ files\?$/ })
              .waitFor();
          }
          const low = await lowContrast(h.page, 4.5);
          check(
            low.length === 0,
            `text below 4.5:1 (3:1 when large):\n      ${low.slice(0, 12).join('\n      ')}`,
          );
          if (scenario === 'isolation') {
            const faint = (await segmentEdges(h.page)).filter((c) => !(c.ratio >= 3));
            check(
              faint.length === 0,
              `selected segment edge below 3:1: ${faint.map((c) => c.name).join(', ')}`,
            );
          }
        },
      );
    }
  }

  return flows;
};
