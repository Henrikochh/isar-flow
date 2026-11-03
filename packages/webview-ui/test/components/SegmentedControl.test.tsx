import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from '../../src/components';

const MODES = [
  { value: 'none', label: 'Off' },
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Read and write' },
];

describe('SegmentedControl', () => {
  it('keeps each label of a control as wide as its labels on one line', () => {
    render(<SegmentedControl label="Memory" value="read" options={MODES} onChange={vi.fn()} />);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toHaveClass('if-segmented__item--fit');
  });

  it('lets full-width controls share their width as before', () => {
    render(<SegmentedControl label="Memory" full value="read" options={MODES} onChange={vi.fn()} />);
    for (const radio of screen.getAllByRole('radio'))
      expect(radio).not.toHaveClass('if-segmented__item--fit');
  });
});
