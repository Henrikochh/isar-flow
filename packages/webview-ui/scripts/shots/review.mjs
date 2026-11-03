/**
 * Shots of the review card, the run history counts and the isolation settings (loaded by scripts/visual.mjs).
 * `node scripts/visual.mjs --only=workflow-review` takes the review shots, `--only=workflow-isolation` the other.
 */
const askRevertAll = async (page) => {
  await page.getByRole('button', { name: 'Revert all' }).focus();
  await page.keyboard.press('Enter');
};

export default [
  // A finished run that changed five files: agent edits, a deleted file, a binary file and a lockfile.
  { view: 'workflow', scenario: 'review', width: 1440, height: 900 },
  // No git: only agent writes, a file that cannot be reverted, a failed revert and an overlapping run.
  { view: 'workflow', scenario: 'review-journal', width: 1440, height: 900 },
  // A worktree run halfway through its review.
  { view: 'workflow', scenario: 'review-worktree', width: 1440, height: 900 },
  // A past run whose files were all decided: the card is folded to its summary, then opened.
  { view: 'workflow', scenario: 'review-done', width: 1440, height: 900 },
  {
    view: 'workflow',
    scenario: 'review-done',
    name: 'review-done-open',
    width: 1440,
    height: 900,
    act: (page) => page.getByRole('button', { name: 'Show review' }).click(),
  },
  // Revert all asks first, with Cancel focused (pressed with the keyboard, so the focus ring shows); the narrow
  // card wraps the question.
  {
    view: 'workflow',
    scenario: 'review',
    name: 'review-confirm',
    width: 1440,
    height: 900,
    act: (page) => askRevertAll(page),
  },
  {
    view: 'workflow',
    scenario: 'review-narrow',
    name: 'review-narrow-confirm',
    width: 900,
    height: 800,
    act: (page) => askRevertAll(page),
  },
  // Keyboard focus on the first decision.
  {
    view: 'workflow',
    scenario: 'review',
    name: 'review-keyboard',
    width: 1440,
    height: 900,
    act: async (page) => {
      await page.getByRole('button', { name: 'Hide review' }).focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
    },
  },
  // Long nested paths on a narrow canvas: the file names stay readable.
  { view: 'workflow', scenario: 'review-narrow', width: 900, height: 800 },
  // 500 listed files and more that are not listed: the list scrolls.
  { view: 'workflow', scenario: 'review-many', width: 1440, height: 900 },
  // The Runs menu with "2 to review" and "3 kept, 1 reverted".
  {
    view: 'workflow',
    scenario: 'review',
    name: 'review-runs',
    width: 1440,
    height: 900,
    act: (page) => page.locator('.wf-runs').click(),
  },
  // Workflow panel: Run in a separate worktree with a setup command.
  { view: 'workflow', scenario: 'isolation', width: 1440, height: 900 },
];
