import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_FILE, MEMORY_MISSING, RELEASE_WORKFLOW, WORKFLOWS } from '../../harness/fixtures';
import { postedOfType, renderSidebar, resetPosted } from './helpers';

beforeEach(resetPosted);

const memoryList = () => screen.getByRole('list', { name: 'Project memory' });

describe('Project memory in the sidebar', () => {
  it('shows one quiet row for a single folder, with the size, and opens the file', async () => {
    const user = userEvent.setup();
    renderSidebar({ memory: [MEMORY_FILE] });
    const rows = within(memoryList()).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Project memory');
    expect(within(rows[0]).getByText('1.3 KB')).toBeInTheDocument();
    // One folder: its name would only repeat the workspace.
    expect(rows[0]).not.toHaveTextContent('shop');
    await user.click(within(rows[0]).getByRole('button', { name: 'Open project memory' }));
    expect(postedOfType('openMemory')).toEqual([{ type: 'openMemory', folderUri: MEMORY_FILE.folderUri }]);
  });

  it('names the folder of each row in a multi-root workspace and offers to create a missing file', async () => {
    const user = userEvent.setup();
    renderSidebar({ memory: [MEMORY_FILE, MEMORY_MISSING] });
    const [shop, docs] = within(memoryList()).getAllByRole('listitem');
    expect(within(shop).getByText('shop')).toBeInTheDocument();
    expect(within(docs).getByText('shop-docs')).toBeInTheDocument();
    expect(within(docs).getByText('Not created yet')).toBeInTheDocument();
    await user.click(within(docs).getByRole('button', { name: 'Create project memory of shop-docs' }));
    expect(postedOfType('openMemory')).toEqual([{ type: 'openMemory', folderUri: MEMORY_MISSING.folderUri }]);
    expect(within(shop).getByRole('button', { name: 'Open project memory of shop' })).toBeInTheDocument();
  });

  it('shows the file path as its tooltip', () => {
    renderSidebar({ memory: [MEMORY_FILE] });
    expect(within(memoryList()).getByTitle('shop/.isarflow/memory.md')).toBeInTheDocument();
  });

  it('shows nothing when the host sent no memory files', () => {
    renderSidebar({ memory: [] });
    expect(screen.queryByRole('list', { name: 'Project memory' })).toBeNull();
  });

  it('shows nothing when the host does not send memory at all', () => {
    renderSidebar({});
    expect(screen.queryByRole('list', { name: 'Project memory' })).toBeNull();
  });

  it('ignores entries a lenient host may send without a folder', () => {
    renderSidebar({ memory: [MEMORY_FILE, null as never, { ...MEMORY_MISSING, folderUri: 7 as never }] });
    expect(within(memoryList()).getAllByRole('listitem')).toHaveLength(1);
  });
});

describe('workflows with triggers or Copilot access', () => {
  it('marks a workflow with triggers with a zap icon whose tooltip lists them', () => {
    renderSidebar({ tab: 'workflows', workflows: [RELEASE_WORKFLOW, ...WORKFLOWS] });
    const row = screen.getByRole('button', { name: /^Release to an environment/ });
    const zap = within(row).getByRole('img', { name: 'Triggers' });
    expect(zap).toHaveClass('codicon-zap');
    expect(zap).toHaveAttribute('title', 'On save: src/**/*.ts, !src/gen/**\nEvery hour');
    const review = screen.getByRole('button', { name: /^Review until approved/ });
    expect(within(review).queryByRole('img', { name: 'Triggers' })).toBeNull();
  });

  it('shows a Copilot chip when Copilot may run the workflow', () => {
    renderSidebar({ tab: 'workflows', workflows: [RELEASE_WORKFLOW, ...WORKFLOWS] });
    const row = screen.getByRole('button', { name: /^Release to an environment/ });
    const chip = within(row).getByText('Copilot', { selector: '.if-chip, .if-chip *' });
    expect(chip.closest('.if-chip')).toHaveAttribute('title', 'Copilot can run this workflow');
    const review = screen.getByRole('button', { name: /^Review until approved/ });
    expect(review).not.toHaveTextContent('Copilot');
  });

  it('ignores malformed trigger lists', () => {
    renderSidebar({
      tab: 'workflows',
      workflows: [{ ...RELEASE_WORKFLOW, triggers: 'save' as never, exposed: 'yes' as never }],
    });
    const row = screen.getByRole('button', { name: /^Release to an environment/ });
    expect(within(row).queryByRole('img', { name: 'Triggers' })).toBeNull();
    expect(row).not.toHaveTextContent('Copilot');
  });
});
