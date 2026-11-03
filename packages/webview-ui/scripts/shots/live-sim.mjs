/**
 * Shots of live values (hover cards, condition results, the inspector's values list) and the inspector's
 * Simulation section (Package B, ui-live-sim). Loaded by scripts/visual.mjs: `--only=workflow-live`,
 * `--only=workflow-simulation`.
 */

/** Scrolls the inspector so the element sits right under its sticky block header. */
const scrollUnderHeader = (locator) =>
  locator.evaluate((el) => {
    const scroller = el.closest('.wf-inspector');
    const sticky = scroller?.querySelector('.wf-insp-sticky');
    const top = sticky ? sticky.getBoundingClientRect().bottom : (scroller?.getBoundingClientRect().top ?? 0);
    if (scroller) scroller.scrollTop += el.getBoundingClientRect().top - top - 12;
  });

/** Hovers a template token on a card and waits for its value card. */
const hoverToken = (stepId, expression) => async (page) => {
  const token = page.locator(`[data-wf-card][data-step-id="${stepId}"] .wf-expr`, { hasText: expression });
  await token.first().scrollIntoViewIfNeeded();
  await token.first().hover();
  await page.getByRole('tooltip').waitFor();
};

/** Selects a block, opens "Values from the last run" under its field and the row of one expression. */
const inspectValues = (stepId, expression) => async (page) => {
  await page.locator(`[data-wf-card][data-step-id="${stepId}"]`).click();
  const inspector = page.locator('.wf-inspector');
  const toggle = inspector.getByRole('button', { name: /^Values from the last run/ }).first();
  await toggle.click();
  await inspector
    .getByRole('button', { name: new RegExp(`^${expression.replace(/[.()]/g, '\\$&')}`) })
    .click();
  await scrollUnderHeader(toggle);
};

/** Selects the loop: the condition builder's summary with the last run's result, chips on the canvas. */
const selectLoop = (page) => page.locator('[aria-label="Loop review_loop"] .wf-loop__head').click();

/** Scrolls the inspector to the Simulation section (opened when it is closed). */
const showSimulation = async (page) => {
  const toggle = page.locator('.wf-inspector').getByRole('button', { name: /^Simulation/ });
  await toggle.waitFor();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await scrollUnderHeader(toggle);
};

const wide = { width: 1440, height: 900 };
const narrow = { width: 900, height: 800 };

export default [
  // No run shown: a card template shows its value from the last run; If and Loop headers show the results.
  { view: 'workflow', scenario: 'live', name: 'live-hover', ...wide, act: hoverToken('fix', 'toJSON') },
  {
    view: 'workflow',
    scenario: 'live',
    name: 'live-hover-narrow',
    ...narrow,
    act: hoverToken('review', 'inputs.task'),
  },
  // A task longer than 2 KB: the value is cut, says so and scrolls inside the card.
  {
    view: 'workflow',
    scenario: 'live-long',
    name: 'live-hover-long',
    ...narrow,
    act: hoverToken('review', 'inputs.task'),
  },
  // The newest run is a simulation: values and condition results say "Last simulation", in its tone.
  {
    view: 'workflow',
    scenario: 'runs-markers',
    name: 'live-hover-simulated',
    ...wide,
    act: hoverToken('fix', 'toJSON'),
  },
  { view: 'workflow', scenario: 'live', name: 'live-condition', ...wide, act: selectLoop },
  { view: 'workflow', scenario: 'live', name: 'live-condition-narrow', ...narrow, act: selectLoop },
  // The values of the fix prompt's templates under the Task field, one row opened.
  {
    view: 'workflow',
    scenario: 'live',
    name: 'live-inspector',
    ...wide,
    act: inspectValues('fix', 'toJSON(steps.review.json.issues)'),
  },
  {
    view: 'workflow',
    scenario: 'live',
    name: 'live-inspector-narrow',
    ...narrow,
    act: inspectValues('review', 'tail(steps.tests.output, 80)'),
  },
  // The console block's mocks: two calls, the last one repeating.
  { view: 'workflow', scenario: 'simulation-console', name: 'simulation', ...wide, act: showSimulation },
  {
    view: 'workflow',
    scenario: 'simulation-console',
    name: 'simulation-narrow',
    ...narrow,
    act: showSimulation,
  },
  // The reviewer's JSON answers.
  { view: 'workflow', scenario: 'simulation', name: 'simulation-json', ...wide, act: showSimulation },
  {
    view: 'workflow',
    scenario: 'simulation',
    name: 'simulation-json-narrow',
    ...narrow,
    act: showSimulation,
  },
  // Warnings for the selected block, and a file that can't be read.
  {
    view: 'workflow',
    scenario: 'simulation-errors',
    name: 'simulation-errors',
    ...wide,
    act: showSimulation,
  },
  {
    view: 'workflow',
    scenario: 'simulation-errors',
    name: 'simulation-errors-narrow',
    ...narrow,
    act: showSimulation,
  },
  {
    view: 'workflow',
    scenario: 'simulation-broken',
    name: 'simulation-broken',
    ...wide,
    act: showSimulation,
  },
];
