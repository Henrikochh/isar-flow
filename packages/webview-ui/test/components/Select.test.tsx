import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Select, type SelectOption } from '../../src/components';

const OPTIONS: SelectOption[] = [
  {
    value: '${{ steps.tests.exitCode }}',
    label: 'tests › exitCode',
    description: 'Exit code of the command',
    group: 'Blocks',
  },
  {
    value: '${{ steps.tests.output }}',
    label: 'tests › output',
    description: 'Everything the command printed',
    group: 'Blocks',
  },
  {
    value: '${{ steps.review.json.approved }}',
    label: 'review › json.approved',
    description: 'Field of the answer',
    group: 'Blocks',
  },
];

beforeAll(() => {
  // jsdom has no layout; the Select scrolls its active option into view.
  Element.prototype.scrollIntoView ??= () => undefined;
});

function open(onChange = vi.fn()) {
  render(
    <Select
      ariaLabel="Rule 1 value"
      value={undefined}
      options={OPTIONS}
      searchable
      allowCustom
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Rule 1 value' }));
  return { onChange, search: screen.getByLabelText('Filter options') };
}

describe('Select search', () => {
  it('matches every typed word, in any order and field', () => {
    const { onChange, search } = open();
    fireEvent.change(search, { target: { value: 'tests exit' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('tests › exitCode'),
      expect.stringContaining('Use "tests exit"'),
    ]);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('${{ steps.tests.exitCode }}');
  });

  it('finds words from the description too', () => {
    const { search } = open();
    fireEvent.change(search, { target: { value: 'printed tests' } });
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('tests › output');
  });

  it('tells assistive technology which option is active while typing', () => {
    const { search } = open();
    expect(search).toHaveAttribute('role', 'combobox');
    expect(search).toHaveAttribute('aria-expanded', 'true');
    const first = search.getAttribute('aria-activedescendant');
    expect(document.getElementById(first ?? '')).toHaveTextContent('tests › exitCode');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const second = search.getAttribute('aria-activedescendant');
    expect(document.getElementById(second ?? '')).toHaveTextContent('tests › output');
  });
});

describe('Select list name', () => {
  it('names the open list like its trigger', () => {
    open();
    expect(screen.getByRole('listbox', { name: 'Rule 1 value' })).toBeInTheDocument();
  });

  it('names the open list by the field label when there is no aria label', () => {
    render(
      <>
        <label htmlFor="answer">Answer</label>
        <Select id="answer" value="dev" options={[{ value: 'dev', label: 'dev' }]} onChange={vi.fn()} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(screen.getByRole('listbox').getAttribute('aria-labelledby')).toBe('answer');
  });
});
