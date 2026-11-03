import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RELEASE_WORKFLOW_TEXT } from '../../../harness/fixtures';
import { docFor, renderInspector, resetPosted } from './helpers';

beforeEach(resetPosted);

describe('editor and git variables', () => {
  it('lists the editor and git roots in the variable picker with icons', () => {
    renderInspector({ doc: docFor(RELEASE_WORKFLOW_TEXT), selection: 'summarize' });
    fireEvent.click(screen.getByRole('button', { name: 'Insert variable' }));
    const list = screen.getByRole('listbox', { name: 'Variables' });
    const editor = within(list).getByText('Editor', { selector: '.if-select__group' });
    expect(editor.querySelector('.codicon')).toHaveClass('codicon-code');
    const git = within(list).getByText('Git', { selector: '.if-select__group' });
    expect(git.querySelector('.codicon')).toHaveClass('codicon-git-branch');
    expect(within(list).getByText('editor.selection')).toBeInTheDocument();
    expect(within(list).getByText('git.diff')).toBeInTheDocument();
  });

  it('offers them in the condition builder too', () => {
    const text = `${RELEASE_WORKFLOW_TEXT}  - id: on-main
    type: if
    condition: { value: "\${{ git.branch }}", op: eq, to: main }
    then: []
`;
    renderInspector({ doc: docFor(text), selection: 'on-main' });
    fireEvent.click(screen.getByRole('button', { name: 'Rule 1 value' }));
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByText('Git', { selector: '.if-select__group' })).toBeInTheDocument();
    const branch = within(listbox).getByRole('option', { name: /git\.branch/ });
    expect(branch.querySelector('.codicon-git-branch')).not.toBeNull();
    expect(within(listbox).getByRole('option', { name: /editor\.file/ })).toBeInTheDocument();
  });
});
