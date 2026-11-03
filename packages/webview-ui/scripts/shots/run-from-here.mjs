/**
 * Shots of Run from here, the Run / Simulate split button and the run markers (Package B, ui-run). Loaded by
 * scripts/visual.mjs: `--only=workflow-resume`, `--only=workflow-simulated`, `--only=workflow-run`.
 */
const cardMenu = (id) => (page) => page.click(`[data-wf-card][data-step-id="${id}"]`, { button: 'right' });

/** The inspector shows the selected block's run output; its Run from here opens the dialog. */
const resumeDialog = async (page) => {
  await page.locator('.wf-inspector').getByRole('button', { name: 'Run from here' }).click();
  await page.getByRole('dialog').waitFor();
};

const splitMenu = (page) => page.getByRole('button', { name: 'More run options' }).click();

export default [
  // The failed run-3 is shown; the card menu of its failed block offers Run from here first.
  {
    view: 'workflow',
    scenario: 'resume',
    name: 'resume-menu',
    width: 1440,
    height: 900,
    act: cardMenu('tests'),
  },
  {
    view: 'workflow',
    scenario: 'resume',
    name: 'resume-menu-narrow',
    width: 900,
    height: 800,
    act: cardMenu('tests'),
  },
  // implement changed since run-3: the dialog warns; the loop continues at iteration 5 of 5.
  {
    view: 'workflow',
    scenario: 'resume-changed',
    name: 'resume-dialog',
    width: 1440,
    height: 900,
    act: resumeDialog,
  },
  {
    view: 'workflow',
    scenario: 'resume-changed',
    name: 'resume-dialog-narrow',
    width: 900,
    height: 800,
    act: resumeDialog,
  },
  // A run resumed from run-3 at tests: reused cards, the Start chip and the summary note.
  { view: 'workflow', scenario: 'resumed', width: 1440, height: 900 },
  // The reused block's run output.
  {
    view: 'workflow',
    scenario: 'resumed',
    name: 'resumed-output',
    width: 1440,
    height: 900,
    act: (page) => page.locator('[data-wf-card][data-step-id="implement"]').click(),
  },
  // A simulated run: the banner over the canvas, the Start chip and the summary note with Edit mocks.
  { view: 'workflow', scenario: 'simulated', width: 1440, height: 900 },
  { view: 'workflow', scenario: 'simulated', name: 'simulated-narrow', width: 900, height: 800 },
  // The Simulate dialog: its own tone, so it never reads as Run.
  {
    view: 'workflow',
    scenario: 'default',
    name: 'simulate-dialog',
    width: 1440,
    height: 900,
    act: async (page) => {
      await splitMenu(page);
      await page
        .getByRole('menu', { name: 'Run options' })
        .getByRole('menuitem', { name: /Simulate/ })
        .click();
      await page.getByRole('dialog').waitFor();
    },
  },
  // A simulation on its way: the banner says Simulating, Stop has the focus.
  {
    view: 'workflow',
    scenario: 'default',
    name: 'simulating',
    width: 1440,
    height: 900,
    act: async (page) => {
      await splitMenu(page);
      await page
        .getByRole('menu', { name: 'Run options' })
        .getByRole('menuitem', { name: /Simulate/ })
        .click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox').fill('Add voucher codes to the checkout');
      await dialog.getByRole('button', { name: 'Simulate' }).click();
      await page.getByRole('status', { name: 'Simulating' }).waitFor();
      await page.waitForTimeout(1200);
    },
  },
  // Run with its menu: Run, Simulate, Edit simulation mocks.
  { view: 'workflow', scenario: 'default', name: 'run-split-menu', width: 1440, height: 900, act: splitMenu },
  {
    view: 'workflow',
    scenario: 'default',
    name: 'run-split-menu-narrow',
    width: 900,
    height: 800,
    act: splitMenu,
  },
  // Keyboard focus on the chevron: the focus ring shows on the split button in every theme.
  {
    view: 'workflow',
    scenario: 'default',
    name: 'run-split-focus',
    width: 1440,
    height: 900,
    act: async (page) => {
      await page.getByRole('button', { name: 'Run', exact: true }).focus();
      await page.keyboard.press('Tab');
    },
  },
  // Restricted Mode: Run is off, Simulate stays available.
  {
    view: 'workflow',
    scenario: 'untrusted',
    name: 'run-split-untrusted',
    width: 1440,
    height: 900,
    act: splitMenu,
  },
  // The Runs menu with a simulated and a resumed run on top and "Run from tests" under the failed run-3.
  {
    view: 'workflow',
    scenario: 'runs-markers',
    name: 'runs-menu-markers',
    width: 1440,
    height: 1000,
    act: (page) => page.locator('.wf-runs').click(),
  },
];
