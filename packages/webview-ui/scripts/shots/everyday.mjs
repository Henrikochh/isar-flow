/* global document */
/**
 * Shots of "Everyday use" (Package C, ui-c): ask blocks (card above the canvas, settings, run output, mocks),
 * triggers on the Start marker and in the workflow settings, Copilot access, run origins, report actions, the agent
 * editor's Memory section and the sidebar's memory rows. Loaded by scripts/visual.mjs: `--only=workflow-ask`,
 * `--only=workflow-triggers`, `--only=agent-memory`, `--only=sidebar-memory`, …
 */

/** Scrolls the element to the top of its scrolling panel (inspector or agent form), under a sticky header. */
const scrollToTop = (locator) =>
  locator.evaluate((el) => {
    const scroller = el.closest('.wf-inspector, .ag-app, .ag-form, .sb-app') ?? document.scrollingElement;
    const sticky = scroller?.querySelector('.wf-insp-sticky');
    const top = sticky ? sticky.getBoundingClientRect().bottom : (scroller?.getBoundingClientRect().top ?? 0);
    if (scroller) scroller.scrollTop += el.getBoundingClientRect().top - Math.max(0, top) - 12;
  });

const card = (page, id) => page.locator(`[data-wf-card][data-step-id="${id}"]`);
const inspector = (page) => page.locator('.wf-inspector');

const openRunsMenu = (page) => page.locator('.wf-runs').click();

/** Selects a block on the canvas. */
const select = (id) => (page) => card(page, id).click();

/** The inspector's section with this heading, scrolled into view. */
const showSection = (name) => (page) =>
  scrollToTop(inspector(page).getByRole('heading', { name, exact: true }));

/** Opens the Advanced group of the selected block's settings. */
const openAdvanced = async (page) => {
  const toggle = inspector(page).getByRole('button', { name: /^Advanced/ });
  await toggle.click();
  await scrollToTop(toggle);
};

/** Opens the Simulation section of the selected block. */
const showSimulation = async (page) => {
  const toggle = inspector(page).getByRole('button', { name: /^Simulation/ });
  await toggle.waitFor();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await scrollToTop(toggle);
};

/** The summarize block's variable picker, scrolled to the values captured from the editor and git. */
const openVariables = async (page) => {
  await card(page, 'summarize').click();
  await inspector(page).getByRole('button', { name: 'Insert variable' }).first().click();
  const editor = page.getByRole('listbox', { name: 'Variables' }).getByText('Editor', { exact: true });
  await editor.scrollIntoViewIfNeeded();
};

/** The agent editor's Memory section in the middle of the view. */
const showMemory = (page) =>
  page
    .getByRole('heading', { name: 'Memory', exact: true })
    .evaluate((el) => el.closest('section')?.scrollIntoView({ block: 'center' }));

const wide = { width: 1440, height: 900 };
const narrow = { width: 900, height: 800 };
const agent = { width: 1280, height: 860 };
const sidebar = { width: 340, height: 820 };
const sidebarNarrow = { width: 240, height: 820 };

export default [
  /* ---- ask blocks ---- */
  // A live run waits at pick-env: the question card over the canvas, the card's awaiting ring.
  { view: 'workflow', scenario: 'ask', ...wide },
  { view: 'workflow', scenario: 'ask', name: 'ask-narrow', ...narrow },
  // The same question in the block's Run output.
  { view: 'workflow', scenario: 'ask', name: 'ask-inspector', ...wide, act: select('pick-env') },
  // Free text with 2.5 minutes left; seven long choices as a list; two questions; time up; with a review card.
  { view: 'workflow', scenario: 'ask-free', ...wide },
  { view: 'workflow', scenario: 'ask-free', name: 'ask-free-narrow', ...narrow },
  { view: 'workflow', scenario: 'ask-many', ...wide },
  { view: 'workflow', scenario: 'ask-two', ...narrow },
  { view: 'workflow', scenario: 'ask-expired', ...wide },
  { view: 'workflow', scenario: 'ask-review', ...wide },
  // Settings of a question with choices (Advanced open) and of a free-text one.
  { view: 'workflow', scenario: 'ask-settings', ...wide },
  { view: 'workflow', scenario: 'ask-settings', name: 'ask-settings-advanced', ...wide, act: openAdvanced },
  {
    view: 'workflow',
    scenario: 'ask-settings',
    name: 'ask-settings-free',
    ...wide,
    act: select('release-notes'),
  },
  // Nobody answered in time: the default was used.
  { view: 'workflow', scenario: 'ask-output', ...wide },
  // Mocks of the ask block.
  { view: 'workflow', scenario: 'simulation-ask', ...wide, act: showSimulation },
  {
    view: 'workflow',
    scenario: 'simulation-ask',
    name: 'simulation-ask-narrow',
    ...narrow,
    act: showSimulation,
  },
  // Editor and Git in the variable picker.
  { view: 'workflow', scenario: 'ask-settings', name: 'variables-editor-git', ...wide, act: openVariables },

  /* ---- triggers ---- */
  { view: 'workflow', scenario: 'triggers', ...wide },
  { view: 'workflow', scenario: 'triggers-paused', ...wide },
  { view: 'workflow', scenario: 'triggers-limited', ...narrow },
  { view: 'workflow', scenario: 'triggers-disabled', ...wide },
  { view: 'workflow', scenario: 'triggers-untrusted', ...wide },
  { view: 'workflow', scenario: 'triggers-invalid', ...narrow },
  { view: 'workflow', scenario: 'triggers-inputs', ...wide },
  { view: 'workflow', scenario: 'triggers-long', ...narrow },
  // Workflow settings: Triggers and Copilot.
  { view: 'workflow', scenario: 'triggers-settings', ...wide, act: showSection('Triggers') },
  {
    view: 'workflow',
    scenario: 'triggers-long',
    name: 'triggers-settings-long',
    ...narrow,
    act: showSection('Triggers'),
  },
  {
    view: 'workflow',
    scenario: 'triggers-settings',
    name: 'triggers-settings-copilot',
    ...wide,
    act: showSection('Copilot'),
  },

  /* ---- origins and reports ---- */
  // The newest run started on save: the Start marker, the summary's note and report actions.
  { view: 'workflow', scenario: 'report-menu', name: 'report-summary', ...wide },
  { view: 'workflow', scenario: 'report-menu', ...wide, act: openRunsMenu },
  { view: 'workflow', scenario: 'origins', ...wide, act: openRunsMenu },
  { view: 'workflow', scenario: 'origins', name: 'origins-narrow', ...narrow, act: openRunsMenu },

  /* ---- agent editor: Memory ---- */
  { view: 'agent', scenario: 'memory', ...agent, act: showMemory },
  { view: 'agent', scenario: 'memory-missing', ...agent, act: showMemory },
  { view: 'agent', scenario: 'memory-over', ...agent, act: showMemory },
  { view: 'agent', scenario: 'memory-user', ...agent, act: showMemory },
  // No workspace folder: no file to show, a note says how to get one.
  { view: 'agent', scenario: 'memory-nofolder', ...agent, act: showMemory },

  /* ---- sidebar: memory rows, triggers and Copilot on workflow rows, origins in recent runs ---- */
  { view: 'sidebar', scenario: 'memory', ...sidebar },
  { view: 'sidebar', scenario: 'narrow-memory', ...sidebarNarrow },
  { view: 'sidebar', scenario: 'memory-workflows', ...sidebar },
  { view: 'sidebar', scenario: 'narrow-memory-workflows', ...sidebarNarrow },
];
