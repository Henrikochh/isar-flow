import { describe, expect, it } from 'vitest';
import { baseName, fileId, relativeTo, samePath, slugify, uniqueName } from '../../../src/store/paths';

describe('slugify', () => {
  it('lowercases and joins words with dashes', () => {
    expect(slugify('Review until approved', 'workflow')).toBe('review-until-approved');
  });

  it('transliterates German umlauts and ß', () => {
    expect(slugify('Größe & Übung', 'x')).toBe('groesse-uebung');
    expect(slugify('Straße', 'x')).toBe('strasse');
    expect(slugify('ÄÖÜ', 'x')).toBe('aeoeue');
  });

  it('drops other accents', () => {
    expect(slugify('Café déjà vu', 'x')).toBe('cafe-deja-vu');
  });

  it('collapses separators and trims dashes', () => {
    expect(slugify('  --Hello__World!!  ', 'x')).toBe('hello-world');
    expect(slugify('a.b/c\\d', 'x')).toBe('a-b-c-d');
  });

  it('uses the fallback when nothing usable is left', () => {
    expect(slugify('日本語', 'agent')).toBe('agent');
    expect(slugify('', 'workflow')).toBe('workflow');
    expect(slugify('---', 'workflow')).toBe('workflow');
  });

  it('caps the length at 48 characters without a trailing dash', () => {
    expect(slugify('a'.repeat(60), 'x')).toBe('a'.repeat(48));
    const slug = slugify(`${'a'.repeat(47)} bcd`, 'x');
    expect(slug).toBe('a'.repeat(47));
    expect(slug.length).toBeLessThanOrEqual(48);
  });
});

describe('uniqueName', () => {
  it('keeps a free name', () => {
    expect(uniqueName('review', new Set())).toBe('review');
  });

  it('appends the first free number starting at 2', () => {
    expect(uniqueName('review', new Set(['review']))).toBe('review-2');
    expect(uniqueName('review', new Set(['review', 'review-2', 'review-4']))).toBe('review-3');
  });
});

describe('fileId', () => {
  it('strips the agent and workflow suffixes', () => {
    expect(fileId('coder.agent.yaml', 'agent')).toBe('coder');
    expect(fileId('coder.agent.yml', 'agent')).toBe('coder');
    expect(fileId('my.review.workflow.yaml', 'workflow')).toBe('my.review');
    expect(fileId('Fix.Workflow.YML', 'workflow')).toBe('Fix');
  });

  it('rejects other files and empty ids', () => {
    expect(fileId('coder.yaml', 'agent')).toBeUndefined();
    expect(fileId('coder.workflow.yaml', 'agent')).toBeUndefined();
    expect(fileId('.agent.yaml', 'agent')).toBeUndefined();
  });
});

describe('path helpers', () => {
  it('returns the last segment', () => {
    expect(baseName('/ws/.isarflow/agents/coder.agent.yaml')).toBe('coder.agent.yaml');
    expect(baseName('coder.agent.yaml')).toBe('coder.agent.yaml');
  });

  it('compares paths, optionally ignoring case and trailing slashes', () => {
    expect(samePath('/c:/Work/a/', '/C:/work/A', true)).toBe(true);
    expect(samePath('/c:/Work/a', '/C:/work/A', false)).toBe(false);
    expect(samePath('/ws/a', '/ws/a', false)).toBe(true);
  });

  it('makes paths relative to a folder with forward slashes', () => {
    expect(relativeTo('/ws', '/ws/.isarflow/workflows/a.workflow.yaml', false)).toBe(
      '.isarflow/workflows/a.workflow.yaml',
    );
    expect(relativeTo('/c:/WS/', '/C:/ws/sub/a.workflow.yaml', true)).toBe('sub/a.workflow.yaml');
    expect(relativeTo('/other', '/ws/a.workflow.yaml', false)).toBe('a.workflow.yaml');
    expect(relativeTo('/ws', '/ws-two/a.workflow.yaml', false)).toBe('a.workflow.yaml');
  });
});
