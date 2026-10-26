import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_MODEL, parseAgentText } from '@isar-flow/core';
import {
  buildAgentIndex,
  classifyAgentPath,
  starterAgentText,
  summarizeAgent,
} from '../../../src/store/agentIndex';

const REVIEWER = `name: Reviewer
description: Strict senior code reviewer
model: litellm/claude-sonnet
tools: [readFile, gitDiff]
permissions: { edits: none, commands: none }
`;

describe('summarizeAgent', () => {
  it('summarizes a valid agent file', () => {
    const record = summarizeAgent(
      REVIEWER,
      'file:///ws/.isarflow/agents/reviewer.agent.yaml',
      'workspace',
      'reviewer',
    );
    expect(record.summary).toEqual({
      id: 'reviewer',
      name: 'Reviewer',
      description: 'Strict senior code reviewer',
      model: 'litellm/claude-sonnet',
      tools: ['readFile', 'gitDiff'],
      scope: 'workspace',
      uri: 'file:///ws/.isarflow/agents/reviewer.agent.yaml',
      valid: true,
    });
    expect(record.definition?.model).toBe('litellm/claude-sonnet');
  });

  it('keeps a lenient summary for schema errors', () => {
    const record = summarizeAgent('name: 42\ntools: [readFile, teleport, readFile]\n', 'u', 'user', 'odd');
    expect(record.summary).toMatchObject({
      id: 'odd',
      name: 'odd',
      model: '',
      tools: ['readFile'],
      valid: false,
    });
    expect(record.summary.description).toBeUndefined();
    expect(record.definition).not.toBeNull();
  });

  it('has no definition when the file is not a mapping', () => {
    for (const text of ['', '- a\n- b\n', 'name: [unclosed\n']) {
      const record = summarizeAgent(text, 'u', 'workspace', 'broken');
      expect(record.definition).toBeNull();
      expect(record.summary).toMatchObject({ name: 'broken', model: '', tools: [], valid: false });
    }
  });
});

describe('buildAgentIndex', () => {
  const agent = (id: string, scope: 'workspace' | 'user', text = `name: ${id}\nmodel: m/${scope}\n`) =>
    summarizeAgent(text, `file:///${scope}/${id}.agent.yaml`, scope, id);

  it('lets workspace agents shadow user agents with the same id', () => {
    const index = buildAgentIndex([
      agent('coder', 'workspace'),
      agent('coder', 'user'),
      agent('helper', 'user'),
    ]);
    const userCoder = index.list.find((a) => a.id === 'coder' && a.scope === 'user');
    expect(userCoder?.shadowed).toBe(true);
    expect(index.list.find((a) => a.id === 'coder' && a.scope === 'workspace')?.shadowed).toBeUndefined();
    expect(index.list.find((a) => a.id === 'helper')?.shadowed).toBeUndefined();
    expect(index.definitions.coder.model).toBe('m/workspace');
    expect(index.definitions.helper.model).toBe('m/user');
  });

  it('keeps the first agent of a scope when ids repeat', () => {
    const first = agent('coder', 'workspace', 'name: First\nmodel: a/b\n');
    const second = summarizeAgent(
      'name: Second\nmodel: c/d\n',
      'file:///ws2/coder.agent.yaml',
      'workspace',
      'coder',
    );
    const index = buildAgentIndex([first, second]);
    expect(index.definitions.coder.name).toBe('First');
    expect(index.list.find((a) => a.name === 'Second')?.shadowed).toBe(true);
  });

  it('only offers valid definitions, and an invalid workspace agent still hides the user agent', () => {
    const index = buildAgentIndex([agent('coder', 'workspace', 'name: Broken\n'), agent('coder', 'user')]);
    expect(index.definitions).toEqual({});
    expect(index.list.find((a) => a.scope === 'user')?.shadowed).toBe(true);
  });

  it('sorts workspace agents first, then by name', () => {
    const index = buildAgentIndex([
      agent('zed', 'user'),
      agent('beta', 'workspace'),
      agent('Alpha', 'workspace'),
      agent('alpha', 'user'),
    ]);
    expect(index.list.map((a) => `${a.scope}:${a.id}`)).toEqual([
      'workspace:Alpha',
      'workspace:beta',
      'user:alpha',
      'user:zed',
    ]);
  });

  it('stores ids like __proto__ as plain keys', () => {
    const index = buildAgentIndex([agent('__proto__', 'workspace')]);
    expect(Object.keys(index.definitions)).toEqual(['__proto__']);
  });
});

describe('classifyAgentPath', () => {
  const dirs = {
    workspace: ['file:/c:/ws/.isarflow/agents', 'file:/d:/two/.isarflow/agents'],
    user: 'file:/c:/global/agents',
  };

  it('identifies workspace and user agent files', () => {
    expect(classifyAgentPath('file:/c:/ws/.isarflow/agents/coder.agent.yaml', dirs, false)).toEqual({
      id: 'coder',
      scope: 'workspace',
    });
    expect(classifyAgentPath('file:/d:/two/.isarflow/agents/x.agent.yml', dirs, false)).toEqual({
      id: 'x',
      scope: 'workspace',
    });
    expect(classifyAgentPath('file:/c:/global/agents/mine.agent.yaml', dirs, false)).toEqual({
      id: 'mine',
      scope: 'user',
    });
  });

  it('ignores case only when asked to', () => {
    const path = 'file:/C:/WS/.isarflow/agents/coder.agent.yaml';
    expect(classifyAgentPath(path, dirs, true)).toEqual({ id: 'coder', scope: 'workspace' });
    expect(classifyAgentPath(path, dirs, false)).toBeUndefined();
  });

  it('rejects files in other folders or with other names', () => {
    expect(
      classifyAgentPath('file:/c:/ws/sub/.isarflow/agents/coder.agent.yaml', dirs, false),
    ).toBeUndefined();
    expect(
      classifyAgentPath('file:/c:/ws/.isarflow/agents/nested/coder.agent.yaml', dirs, false),
    ).toBeUndefined();
    expect(classifyAgentPath('file:/c:/ws/.isarflow/agents/coder.yaml', dirs, false)).toBeUndefined();
  });
});

describe('starterAgentText', () => {
  it('creates a blank agent with the default model and the given name', () => {
    const agent = parseAgentText(starterAgentText('Docs writer', 'blank'));
    expect(agent.valid).toBe(true);
    expect(agent.agent).toMatchObject({ name: 'Docs writer', model: DEFAULT_AGENT_MODEL });
  });

  it('uses the coder and reviewer starters and keeps a custom name', () => {
    const coder = parseAgentText(starterAgentText('Coder', 'coder')).agent;
    expect(coder?.name).toBe('Coder');
    expect(coder?.tools).toContain('editFile');
    const reviewer = parseAgentText(starterAgentText('Strict reviewer', 'reviewer'));
    expect(reviewer.valid).toBe(true);
    expect(reviewer.agent).toMatchObject({ name: 'Strict reviewer', model: DEFAULT_AGENT_MODEL });
    expect(starterAgentText('  ', 'reviewer')).toContain('name: Reviewer');
  });
});
