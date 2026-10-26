import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TemplateTextArea, templateSegments } from '../../../src/views/workflow/inspector/TemplateTextArea';

describe('TemplateTextArea', () => {
  it('splits text into plain runs and templates', () => {
    expect(templateSegments('Fix ${{ steps.tests.exitCode }} now')).toEqual([
      { text: 'Fix ', template: false },
      { text: '${{ steps.tests.exitCode }}', template: true },
      { text: ' now', template: false },
    ]);
    expect(templateSegments('broken ${{ steps')).toEqual([{ text: 'broken ${{ steps', template: false }]);
    expect(templateSegments('')).toEqual([]);
  });

  it('marks templates in a mirror behind the editable text', () => {
    const { container } = render(<TemplateTextArea aria-label="Task" value="Use ${{ inputs.task }}" onChange={() => {}} />);
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('${{ inputs.task }}');
    expect(container.querySelector('[aria-hidden="true"]')).toContainElement(marks[0] as HTMLElement);
    expect(container.querySelector('textarea')).toHaveValue('Use ${{ inputs.task }}');
  });
});
