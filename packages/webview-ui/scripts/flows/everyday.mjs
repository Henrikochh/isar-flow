/* global window, document */
/**
 * Flows of "Everyday use" (Package C, ui-c): answering ask blocks (card, inspector, keyboard), ask settings, triggers
 * on the Start marker and in the workflow settings, Copilot access, run reports, run origins, ask mocks, the agent
 * editor's Memory section and the sidebar's memory rows, plus contrast and names of every new view. Loaded by
 * scripts/interactions.mjs: `npm run interactions -w @isar-flow/webview-ui -- --only=everyday`.
 */
export default ({ check, checkEqual, until, lowContrast, unnamedControls, segmentEdges }) => {
  const flows = [];
  const flow = (name, options, run) => flows.push({ name: `everyday: ${name}`, options, run });
  const visible = (locator) => async () => (await locator.count()) > 0 && locator.first().isVisible();
  const gone = (locator) => async () => (await locator.count()) === 0;
  const probe = (page, name) => page.evaluate((n) => window.__harness.probe[n]?.(), name);
  const questions = (page) => page.locator('.wf-banners').getByRole('status', { name: /^Question/ });
  const question = (page, block) =>
    page.locator('.wf-banners').getByRole('status', { name: new RegExp(`^Question ${block}`) });
  const startMarker = (page) => page.locator('.wf-marker').first();
  const runsButton = (page) => page.locator('.wf-runs');
  const inspector = (page) => page.locator('.wf-inspector');
  const WIDE = { width: 1440, height: 900 };

  /* ---- ask blocks ---- */

  flow(
    'a choice button answers, the card goes and the run asks the next question',
    { view: 'workflow', scenario: 'ask' },
    async (h) => {
      const { page } = h;
      const pick = question(page, 'pick-env');
      await until(visible(pick), 'the question card is pinned above the canvas');
      check(
        (await h.card('pick-env').getAttribute('class')).includes('wf-card--awaiting'),
        'the waiting block has the awaiting ring',
      );
      const countdown = await pick.innerText();
      check(
        /Answer within [45]:[0-9]{2}; then 'dev' is used\./.test(countdown),
        `the countdown says what happens without an answer: ${countdown}`,
      );
      await pick.getByRole('button', { name: 'staging', exact: true }).click();
      await until(async () => (await h.posted('answer')).length === 1, 'the answer is posted');
      checkEqual((await h.posted('answer'))[0].answer, 'staging', 'with the chosen answer');
      await until(gone(pick), 'the card goes away');
      const notes = question(page, 'release-notes');
      await until(visible(notes), 'the run goes on and asks the free-text question');
      const input = notes.getByRole('textbox', { name: 'Answer' });
      checkEqual(await input.inputValue(), 'Routine release', 'the text field starts with the default');
      await input.fill('Faster checkout');
      await input.press('Enter');
      await until(async () => (await h.posted('answer')).length === 2, 'Enter answers');
      checkEqual((await h.posted('answer'))[1].answer, 'Faster checkout', 'with the typed text');
      await until(
        async () => (await runsButton(page).innerText()).includes('Succeeded'),
        'the run ends',
        20_000,
      );
      await h.card('deploy').click();
      await until(
        async () => (await inspector(page).innerText()).includes('npm run deploy -- --env staging'),
        'deploy ran with the answer',
      );
    },
  );

  flow(
    'keyboard only: the question takes the focus, Enter answers with the default, the next one follows',
    { view: 'workflow', scenario: 'ask' },
    async (h) => {
      const { page } = h;
      const pick = question(page, 'pick-env');
      await until(visible(pick), 'the question card is shown');
      await until(async () => (await h.focused()) === 'dev, default', 'the default answer has the focus');
      const focusRing = () => page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false);
      check(await focusRing(), 'and shows the focus ring');
      check(
        (await pick.getByRole('group', { name: 'Which environment should I deploy to?' }).count()) === 1,
        'the answer buttons are named by the question',
      );
      await page.keyboard.press('Tab');
      await until(async () => (await h.focused()) === 'staging', 'Tab moves to the next choice');
      check(await focusRing(), 'the focused choice shows the focus ring');
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Enter');
      await until(async () => (await h.posted('answer')).length === 1, 'Enter answers');
      checkEqual((await h.posted('answer'))[0].answer, 'dev', 'with the default');
      const notes = question(page, 'release-notes');
      await until(visible(notes), 'the run goes on and asks the free-text question');
      await until(async () => (await h.focused()) === 'Answer', 'the focus moves to its text field');
      await page.keyboard.type('Hotfix');
      await page.keyboard.press('Enter');
      await until(async () => (await h.posted('answer')).length === 2, 'Enter answers the second question');
      checkEqual((await h.posted('answer'))[1].answer, 'Hotfix', 'typing replaced the selected default');
    },
  );

  flow(
    'a new question does not take the focus from a field being typed in',
    { view: 'workflow', scenario: 'ask' },
    async (h) => {
      const { page } = h;
      const pick = question(page, 'pick-env');
      await until(visible(pick), 'the question card is shown');
      await inspector(page).getByRole('tab', { name: 'Workflow' }).click();
      const name = inspector(page).getByLabel('Name', { exact: true });
      await name.click();
      await name.press('End');
      // A script click answers without moving the focus, as if another view had answered.
      await pick.getByRole('button', { name: 'staging', exact: true }).evaluate((button) => button.click());
      await until(visible(question(page, 'release-notes')), 'the next question arrives');
      await page.waitForTimeout(200);
      check(
        await name.evaluate((el) => el === document.activeElement),
        `the focus stays in the Name field (it is on ${await h.focused()})`,
      );
    },
  );

  flow(
    'free text: Enter answers with the default; the countdown runs',
    { view: 'workflow', scenario: 'ask-free' },
    async (h) => {
      const { page } = h;
      const notes = question(page, 'release-notes');
      await until(visible(notes), 'the free-text question is shown');
      const countdown = await notes.innerText();
      check(
        /Answer within 2:[0-9]{2}; then 'Routine release' is used\./.test(countdown),
        `countdown: ${countdown}`,
      );
      await notes.getByRole('textbox', { name: 'Answer' }).press('Enter');
      await until(async () => (await h.posted('answer')).length === 1, 'Enter answers');
      checkEqual((await h.posted('answer'))[0].answer, 'Routine release', 'the default is the answer');
    },
  );

  flow('many choices: a list and Answer', { view: 'workflow', scenario: 'ask-many' }, async (h) => {
    const { page } = h;
    const pick = question(page, 'pick-env');
    await until(visible(pick), 'the question card is shown');
    await until(async () => (await h.focused()) === 'Answer', 'Answer has the focus, the default chosen');
    checkEqual(
      await pick.getByRole('button', { name: 'staging', exact: true }).count(),
      0,
      'no button per choice',
    );
    await pick.getByRole('button', { name: 'Answer from the list' }).click();
    await page.getByRole('option', { name: 'load-test' }).click();
    await pick.getByRole('button', { name: 'Answer', exact: true }).click();
    await until(async () => (await h.posted('answer')).length === 1, 'Answer posts the answer');
    checkEqual((await h.posted('answer'))[0].answer, 'load-test', 'the chosen entry');
  });

  flow(
    'the block’s Run output answers the same question',
    { view: 'workflow', scenario: 'ask' },
    async (h) => {
      const { page } = h;
      await h.card('pick-env').click();
      const form = inspector(page).getByRole('status', { name: /^Question/ });
      await until(visible(form), 'the inspector shows the question');
      await form.getByRole('button', { name: 'prod', exact: true }).click();
      await until(async () => (await h.posted('answer')).length === 1, 'the answer is posted');
      checkEqual((await h.posted('answer'))[0].answer, 'prod', 'from the inspector');
      await until(gone(question(page, 'pick-env')), 'the card above the canvas goes too');
    },
  );

  flow('time up: says the default is used', { view: 'workflow', scenario: 'ask-expired' }, async (h) => {
    const pick = question(h.page, 'pick-env');
    await until(visible(pick), 'the question card is shown');
    check((await pick.innerText()).includes("Time is up; 'dev' is used."), 'the countdown has ended');
  });

  flow(
    'two questions stack and each answers its own',
    { view: 'workflow', scenario: 'ask-two' },
    async (h) => {
      const { page } = h;
      await until(async () => (await questions(page).count()) === 2, 'both cards are shown');
      await question(page, 'release-notes').getByRole('button', { name: 'Answer', exact: true }).click();
      await until(async () => (await questions(page).count()) === 1, 'the answered card goes');
      checkEqual((await h.posted('answer'))[0].requestId, 'ask-extra', 'for its own request');
    },
  );

  flow(
    'the run output of a timed-out question says the default was used',
    { view: 'workflow', scenario: 'ask-output' },
    async (h) => {
      const output = inspector(h.page);
      await until(visible(output.getByText('Default used')), 'the chip says the default was used');
      check(
        (await output.innerText()).includes('Which environment should I deploy to?'),
        'the question is shown',
      );
    },
  );

  /* ---- ask settings ---- */

  flow(
    'ask settings: answers, choices, default and timeout reach the YAML',
    { view: 'workflow', scenario: 'ask-settings' },
    async (h) => {
      const { page } = h;
      const settings = inspector(page);
      const yaml = () => h.workflowYaml();
      const pickEnv = async () => {
        const text = await yaml();
        return text.slice(text.indexOf('- id: pick-env'), text.indexOf('- id: release-notes'));
      };
      await settings.getByRole('radio', { name: 'Free text' }).click();
      await until(async () => !(await pickEnv()).includes('choices:'), 'Free text removes the choices');
      check((await pickEnv()).includes('default: dev'), 'the default stays');
      await settings.getByRole('radio', { name: 'Choices' }).click();
      await until(
        async () => /choices: \[dev\]|choices:\n\s+- dev/.test(await pickEnv()),
        'Choices starts with the default as a choice',
      );
      await settings.getByRole('button', { name: 'Add choice' }).click();
      await until(async () => (await h.focused()) === 'Choice 2', 'the new row has the focus');
      await page.keyboard.type('prod');
      await page.keyboard.press('Alt+ArrowUp');
      await until(
        async () => /choices: \[prod, dev\]|choices:\n\s+- prod\n\s+- dev/.test(await pickEnv()),
        'Alt+Up moves the choice up',
      );
      await until(async () => (await h.focused()) === 'Choice 1', 'the moved row keeps the focus');
      await settings.getByRole('button', { name: 'Default answer' }).click();
      await page.getByRole('option', { name: 'No default' }).click();
      await until(async () => !(await pickEnv()).includes('default:'), 'No default removes it');
      await settings.getByRole('button', { name: /^Advanced/ }).click();
      const timeout = settings
        .getByRole('spinbutton', { name: 'Timeout' })
        .or(settings.getByLabel('Timeout'));
      await timeout.first().fill('60');
      await timeout.first().press('Tab');
      await until(async () => (await pickEnv()).includes('timeout: 60'), 'the timeout is written');
      check(
        await settings
          .getByText('Without an answer in time the default is used; without a default the block fails.')
          .isVisible(),
        'the timeout hint explains what happens',
      );
    },
  );

  flow(
    'the variable picker lists Editor and Git and inserts them',
    { view: 'workflow', scenario: 'ask-settings' },
    async (h) => {
      const { page } = h;
      await h.card('summarize').click();
      await inspector(page).getByRole('button', { name: 'Insert variable' }).first().click();
      const list = page.getByRole('listbox', { name: 'Variables' });
      await until(visible(list.getByText('Editor', { exact: true })), 'the Editor group is listed');
      check(await list.getByText('Git', { exact: true }).isVisible(), 'and the Git group');
      await list.getByRole('option', { name: /git\.branch/ }).click();
      await until(
        async () => (await h.workflowYaml()).includes('${{ git.branch }}'),
        'git.branch is inserted',
      );
    },
  );

  /* ---- triggers ---- */

  flow(
    'the Start marker lists the triggers and when the next run starts',
    { view: 'workflow', scenario: 'triggers' },
    async (h) => {
      const marker = startMarker(h.page);
      const triggers = marker.getByRole('group', { name: 'Triggers' });
      await until(visible(triggers), 'the triggers are on the Start marker');
      const text = await triggers.innerText();
      check(text.includes('On save: src/**/*.ts, !src/gen/**'), 'the save trigger with its patterns');
      check(text.includes('Every hour'), 'the schedule');
      check(text.includes('Next run in 12 min'), 'when the schedule runs next');
      checkEqual(
        await triggers.locator('.if-chip').first().getAttribute('title'),
        'Runs when you save a file matching src/**/*.ts, except src/gen/**',
        'the chip tooltip says every pattern',
      );
    },
  );

  flow(
    'paused for approval: Run once runs the workflow',
    { view: 'workflow', scenario: 'triggers-paused' },
    async (h) => {
      const marker = startMarker(h.page);
      await until(visible(marker.getByText('Triggers paused')), 'the marker says the triggers are paused');
      await marker.getByRole('button', { name: 'Run once' }).click();
      await until(async () => (await h.posted('run')).length === 1, 'Run once starts a run');
    },
  );

  flow(
    'paused for starting too often: Resume turns them on again',
    { view: 'workflow', scenario: 'triggers-limited' },
    async (h) => {
      const marker = startMarker(h.page);
      await marker.getByRole('button', { name: 'Resume' }).click();
      await until(async () => (await h.posted('resumeTriggers')).length === 1, 'resumeTriggers is posted');
      await until(gone(marker.getByText('Triggers paused')), 'the triggers run again');
      checkEqual(await probe(h.page, 'resumedTriggers'), 1, 'the host resumed them once');
    },
  );

  flow(
    'turned off in the settings: Open settings opens them',
    { view: 'workflow', scenario: 'triggers-disabled' },
    async (h) => {
      await startMarker(h.page).getByRole('button', { name: 'Open settings' }).click();
      await until(async () => (await h.posted('openSettings')).length === 1, 'openSettings is posted');
      checkEqual(
        (await h.posted('openSettings'))[0].query,
        'isarFlow.triggers.enabled',
        'for the trigger setting',
      );
    },
  );

  flow('a skipped start says why', { view: 'workflow', scenario: 'triggers-long' }, async (h) => {
    const text = await startMarker(h.page).getByRole('group', { name: 'Triggers' }).innerText();
    check(
      text.includes('Not started on save of src/app.ts') &&
        text.includes('The workflow was already running.'),
      `the status line names the skipped start: ${text}`,
    );
  });

  flow(
    'trigger settings write on: and the marker follows',
    { view: 'workflow', scenario: 'triggers-settings' },
    async (h) => {
      const { page } = h;
      const settings = inspector(page);
      const yaml = () => h.workflowYaml();
      /** Switches are checkboxes: Space toggles them from the keyboard. */
      const toggle = async (locator) => {
        await locator.focus();
        await page.keyboard.press('Space');
      };
      await toggle(settings.getByRole('switch', { name: 'Run on save' }));
      await until(async () => !(await yaml()).includes('save:'), 'Run on save off removes the save trigger');
      check((await yaml()).includes('schedule:'), 'the schedule stays');
      await toggle(settings.getByRole('switch', { name: 'Run on a schedule' }));
      await until(async () => !/^on:/m.test(await yaml()), 'without triggers on: goes away');
      await until(
        gone(startMarker(page).getByRole('group', { name: 'Triggers' })),
        'the Start marker shows no triggers',
      );

      await toggle(settings.getByRole('switch', { name: 'Run when files change' }));
      await until(async () => (await h.focused()) === 'Pattern 1', 'a pattern row opens with the focus');
      check(!(await yaml()).includes('change:'), 'nothing is written before a pattern is typed');
      await page.keyboard.type('package-lock.json');
      await page.keyboard.press('Tab');
      await until(
        async () =>
          /change:\n\s+files: \[package-lock\.json\]|change:\n\s+files:\n\s+- package-lock\.json/.test(
            await yaml(),
          ),
        'the change trigger is written',
      );

      await toggle(settings.getByRole('switch', { name: 'Run on a schedule' }));
      const every = settings.getByRole('textbox', { name: 'Every' });
      await until(visible(every), 'the Every field opens');
      await every.fill('30s');
      await until(
        visible(settings.getByText('Use 1m or more: schedules run at most once a minute.')),
        'too short is explained',
      );
      await every.fill('soon');
      await until(
        visible(settings.getByText('Use a duration like 15m, 1h or 1h30m.')),
        'an invalid duration is explained',
      );
      check(!(await yaml()).includes('schedule:'), 'invalid durations are not written');
      await settings.getByRole('button', { name: '1 day' }).click();
      await until(async () => (await yaml()).includes('every: 1d'), 'a preset writes the schedule');
      checkEqual(
        (await h.posted('ops')).flatMap((m) => m.ops).at(-1),
        {
          op: 'updateWorkflow',
          set: { on: { change: { files: ['package-lock.json'] }, schedule: { every: '1d' } } },
        },
        'the last ops message sets the whole on: map',
      );
      check(
        (await settings.getByRole('button', { name: '1 day' }).getAttribute('aria-pressed')) === 'true',
        'the preset in the field is pressed',
      );
      await until(visible(startMarker(page).getByText('Every day')), 'the Start marker shows it');
    },
  );

  flow('the Copilot switch writes expose', { view: 'workflow', scenario: 'triggers-settings' }, async (h) => {
    const toggle = inspector(h.page).getByRole('switch', { name: 'Let Copilot run this workflow' });
    const flip = async (locator) => {
      await locator.focus();
      await h.page.keyboard.press('Space');
    };
    check(await toggle.isChecked(), 'the release workflow is exposed');
    await flip(toggle);
    await until(async () => !(await h.workflowYaml()).includes('expose:'), 'off removes expose');
    await flip(toggle);
    await until(async () => (await h.workflowYaml()).includes('expose: true'), 'on writes expose: true');
    checkEqual(
      (await h.posted('ops')).flatMap((m) => m.ops),
      [
        { op: 'updateWorkflow', set: {}, unset: ['expose'] },
        { op: 'updateWorkflow', set: { expose: true } },
      ],
      'the ops sent to the host',
    );
  });

  /* ---- reports and origins ---- */

  flow(
    'the Runs menu exports a report and copies the PR text',
    { view: 'workflow', scenario: 'report-menu' },
    async (h) => {
      const { page } = h;
      const menu = page.getByRole('menu', { name: 'Runs' });
      await runsButton(page).click();
      await menu.getByRole('menuitem', { name: 'Export report…' }).click();
      await until(async () => (await probe(page, 'reports'))?.length === 1, 'the export is asked for');
      checkEqual(
        (await probe(page, 'reports'))[0],
        { runId: 'run-12', action: 'export' },
        'for the shown run',
      );
      check(
        await page.evaluate(() => document.activeElement?.classList.contains('wf-runs')),
        'the focus is back on Runs',
      );
      await runsButton(page).click();
      await menu.getByRole('menuitem', { name: 'Copy for PR description' }).click();
      await until(visible(menu.getByRole('menuitem', { name: 'Copied' })), 'the item says Copied');
      checkEqual(
        (await probe(page, 'reports'))[1],
        { runId: 'run-12', action: 'copyForPr' },
        'the PR text is asked for',
      );
      await until(
        visible(menu.getByRole('menuitem', { name: 'Copy for PR description' })),
        'and back after 2 s',
        4000,
      );
    },
  );

  flow(
    'the run summary exports a report and copies the PR text',
    { view: 'workflow', scenario: 'report-menu' },
    async (h) => {
      const summary = inspector(h.page);
      check(
        await summary.getByText('Started on save of src/app.ts.').isVisible(),
        'the summary says how the run started',
      );
      await summary.getByRole('button', { name: 'Export report…' }).click();
      await summary.getByRole('button', { name: 'Copy for PR description' }).click();
      await until(visible(summary.getByRole('button', { name: 'Copied' })), 'the button says Copied');
      checkEqual(
        await h.posted('runReport'),
        [
          { type: 'runReport', runId: 'run-12', action: 'export' },
          { type: 'runReport', runId: 'run-12', action: 'copyForPr' },
        ],
        'both are posted for the shown run',
      );
    },
  );

  flow(
    'origins: chips in the Runs menu say how each run started',
    { view: 'workflow', scenario: 'origins' },
    async (h) => {
      const { page } = h;
      await until(
        visible(startMarker(page).getByText('On save', { exact: true })),
        'the Start marker says On save',
      );
      await runsButton(page).click();
      const items = page.getByRole('menu', { name: 'Runs' });
      const chip = (text) => items.locator('.if-chip', { hasText: text }).first();
      checkEqual(await chip('On save').getAttribute('title'), 'Started on save of src/app.ts', 'save');
      checkEqual(await chip('Copilot').getAttribute('title'), 'Started by Copilot', 'Copilot');
      checkEqual(await chip('Selection').getAttribute('title'), 'Started on a selection', 'selection');
      checkEqual(await chip('Scheduled').getAttribute('title'), 'Started by its schedule', 'schedule');
    },
  );

  /* ---- ask mocks ---- */

  flow(
    'ask mocks: picking an answer writes the simulation file',
    { view: 'workflow', scenario: 'simulation-ask' },
    async (h) => {
      const { page } = h;
      const call = inspector(page).getByRole('group', { name: 'Call 1' });
      await until(visible(call), 'the mocks are shown');
      await call.getByRole('button', { name: 'Answer' }).click();
      await page.getByRole('option', { name: 'prod', exact: true }).click();
      await until(
        async () => ((await probe(page, 'simulationText')) ?? '').match(/answer: prod/g)?.length === 2,
        'call 1 answers prod',
      );
    },
  );

  /* ---- agent editor: Memory ---- */

  flow(
    'memory modes write the agent file; Open posts openMemory',
    { view: 'agent', scenario: 'memory' },
    async (h) => {
      const { page } = h;
      const modes = page.getByRole('radiogroup', { name: 'Project memory' });
      checkEqual(
        await modes.getByRole('radio', { name: 'Read and write' }).getAttribute('aria-checked'),
        'true',
        'write mode',
      );
      await modes.getByRole('radio', { name: 'Read', exact: true }).click();
      await until(
        async () => !(await h.agentYaml()).includes('memory:'),
        'Read is the default, so the key goes',
      );
      await modes.getByRole('radio', { name: 'Read', exact: true }).focus();
      await page.keyboard.press('ArrowLeft');
      await until(async () => (await h.agentYaml()).includes('memory: none'), 'ArrowLeft picks Off');
      await page.getByRole('button', { name: 'Open memory file' }).click();
      await until(async () => (await h.posted('openMemory')).length === 1, 'openMemory is posted');
      await until(async () => (await probe(page, 'openedMemory'))?.length === 1, 'it reaches the host');
      checkEqual(await probe(page, 'openedMemory'), [null], 'the host opens the memory file');
    },
  );

  flow('a missing memory file can be created', { view: 'agent', scenario: 'memory-missing' }, async (h) => {
    await h.page.getByRole('button', { name: 'Create memory file' }).click();
    await until(async () => (await h.posted('openMemory')).length === 1, 'openMemory is posted');
  });

  /* ---- sidebar ---- */

  flow(
    'sidebar memory rows open or create the file of their folder',
    { view: 'sidebar', scenario: 'memory', width: 340 },
    async (h) => {
      const { page } = h;
      await page.getByRole('button', { name: 'Open project memory of shop' }).click();
      await page.getByRole('button', { name: 'Create project memory of shop-docs' }).click();
      await until(async () => (await probe(page, 'openedMemory'))?.length === 2, 'both reach the host');
      checkEqual(
        await probe(page, 'openedMemory'),
        ['file:///c%3A/work/shop', 'file:///c%3A/work/shop-docs'],
        'with the folder of each row',
      );
    },
  );

  flow(
    'sidebar workflow rows show triggers and Copilot access',
    { view: 'sidebar', scenario: 'memory-workflows', width: 340 },
    async (h) => {
      const row = h.page.getByRole('button', { name: /^Release to an environment/ });
      checkEqual(
        await row.getByRole('img', { name: 'Triggers' }).getAttribute('title'),
        'On save: src/**/*.ts, !src/gen/**\nEvery hour',
        'the zap names the triggers',
      );
      check(await row.getByText('Copilot', { exact: true }).isVisible(), 'the Copilot chip is shown');
    },
  );

  /* ---- contrast, names and segmented controls of every new view ---- */

  const views = [
    ['workflow', 'ask', undefined],
    ['workflow', 'ask-free', undefined],
    ['workflow', 'ask-two', undefined],
    ['workflow', 'ask-review', undefined],
    [
      'workflow',
      'ask-many',
      'list',
      (page) => page.getByRole('button', { name: 'Answer from the list' }).click(),
    ],
    ['workflow', 'ask-settings', undefined],
    ['workflow', 'ask-output', undefined],
    ['workflow', 'simulation-ask', undefined],
    ['workflow', 'triggers', undefined],
    ['workflow', 'triggers-paused', undefined],
    ['workflow', 'triggers-limited', undefined],
    ['workflow', 'triggers-long', undefined],
    ['workflow', 'triggers-settings', undefined],
    ['workflow', 'report-menu', 'runs menu', (page) => runsButton(page).click()],
    ['workflow', 'origins', 'runs menu', (page) => runsButton(page).click()],
    ['agent', 'memory', undefined],
    ['agent', 'memory-over', undefined],
    ['agent', 'memory-user', undefined],
    ['agent', 'memory-nofolder', undefined],
    ['sidebar', 'memory', undefined],
    ['sidebar', 'memory-workflows', undefined],
  ];
  const label = ([view, scenario, name]) => `${view} ${scenario}${name ? ` ${name}` : ''}`;
  const size = (view) =>
    view === 'sidebar' ? { width: 340, height: 900 } : view === 'agent' ? { width: 1280, height: 860 } : WIDE;
  for (const theme of ['dark', 'light', 'hc', 'hcl']) {
    for (const entry of views) {
      const [view, scenario, , act] = entry;
      flow(`contrast ${label(entry)} (${theme})`, { view, scenario, theme, ...size(view) }, async (h) => {
        if (act) await act(h.page);
        await h.page.waitForTimeout(200);
        const low = await lowContrast(h.page, 4.5);
        check(
          low.length === 0,
          `text below 4.5:1 (3:1 when large):\n      ${low.slice(0, 12).join('\n      ')}`,
        );
      });
    }
    for (const [view, scenario] of [
      ['workflow', 'ask-settings'],
      ['agent', 'memory'],
    ]) {
      flow(
        `segmented: selected choice stands out in ${view} ${scenario} (${theme})`,
        { view, scenario, theme, ...size(view) },
        async (h) => {
          const controls = await segmentEdges(h.page);
          check(controls.length > 0, 'the page shows a segmented control');
          const faint = controls.filter((c) => !(c.ratio >= 3));
          check(
            faint.length === 0,
            `selected segment edge below 3:1:\n      ${faint.map((c) => `${c.ratio.toFixed(2)} "${c.selected}" in ${c.name}`).join('\n      ')}`,
          );
        },
      );
    }
  }
  for (const entry of views) {
    const [view, scenario, , act] = entry;
    flow(`names ${label(entry)}`, { view, scenario, ...size(view) }, async (h) => {
      if (act) await act(h.page);
      await h.page.waitForTimeout(200);
      const bad = await unnamedControls(h.page);
      check(bad.length === 0, `unnamed controls: ${[...new Set(bad)].join(', ')}`);
    });
  }
  flow(
    'narrow window: the question card fits at 900 px',
    { view: 'workflow', scenario: 'ask', width: 900, height: 800 },
    async (h) => {
      const card = question(h.page, 'pick-env');
      await until(visible(card), 'the card is shown');
      const box = await card.boundingBox();
      const main = await h.page.locator('.wf-main').boundingBox();
      check(
        box.x >= main.x && box.x + box.width <= main.x + main.width + 1,
        'the card stays inside the canvas column',
      );
      check(
        await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        'the page does not scroll sideways',
      );
    },
  );

  return flows;
};
