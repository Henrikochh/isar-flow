import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('webview-ui', () => {
  it('renders React in jsdom', () => {
    render(<p>Isar Flow</p>);
    expect(screen.getByText('Isar Flow')).toBeInTheDocument();
  });
});
