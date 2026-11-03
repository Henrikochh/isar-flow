/**
 * Shots for time and tokens per block, capability badges, "Test model" and the setup check (Package A, ui-insights).
 * Loaded by scripts/visual.mjs; each entry has the shape of its SHOTS entries. The default sidebar shot there shows
 * the agents' capability badges, and narrow-newagent the Blank starter hint.
 */
export default [
  // A finished run: metrics rows on the cards, the run summary table with totals and trends in the inspector.
  { view: 'workflow', scenario: 'metrics', width: 1440, height: 900 },
  {
    view: 'workflow',
    scenario: 'metrics',
    name: 'metrics-trends',
    width: 1440,
    height: 900,
    act: (page) =>
      page.locator('.wf-inspector').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      }),
  },
  { view: 'workflow', scenario: 'metrics', name: 'metrics-narrow', width: 900, height: 900 },
  // The run output of an agent block that ran in a loop: totals, average per execution, cost and the trend line.
  {
    view: 'workflow',
    scenario: 'metrics',
    name: 'metrics-output',
    width: 1440,
    height: 900,
    act: (page) => page.locator('[data-wf-card][data-step-id="review"]').click(),
  },
  { view: 'sidebar', scenario: 'setup', width: 340, height: 1100 },
  { view: 'sidebar', scenario: 'setuprunning', width: 340, height: 820 },
  { view: 'sidebar', scenario: 'narrow-setup', width: 240, height: 1300 },
  // The Blank starter explains that it is read-only and suggests Coder.
  {
    view: 'sidebar',
    scenario: 'narrow-newagent',
    name: 'narrow-newagent-blank',
    width: 240,
    height: 820,
    act: (page) => page.getByRole('radio', { name: 'Blank' }).click(),
  },
  {
    view: 'agent',
    scenario: 'default',
    name: 'tools-readonly',
    width: 1280,
    height: 860,
    act: (page) =>
      page.getByRole('heading', { name: 'Tools' }).evaluate((el) => el.scrollIntoView({ block: 'start' })),
  },
  // The agent's model needs text tool mode: the probe result and the note on how Automatic copes.
  { view: 'agent', scenario: 'probed', width: 1280, height: 860 },
  {
    view: 'agent',
    scenario: 'probed',
    name: 'probed-picker',
    width: 1280,
    height: 860,
    act: (page) => page.getByRole('button', { name: /Main model/ }).click(),
  },
  { view: 'agent', scenario: 'textmode', width: 1280, height: 860 },
];
