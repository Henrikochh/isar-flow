import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../src/agents';
import { loadProjectConfig } from '../src/config';
import { displayPath, formatDiagnostic } from '../src/diagnostics';
import { CliError } from '../src/errors';
import { readTextFile } from '../src/files';
import { loadSimulation } from '../src/simulation';
import { checkWorkflow } from '../src/workflow';
import { makeTempDir, removeDir, writeFile } from './helpers';

let root: string;

beforeEach(() => {
  root = makeTempDir('isar-cli-files-');
});
afterEach(() => removeDir(root));

const thrown = async (promise: Promise<unknown> | (() => unknown)): Promise<CliError> => {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('Expected a CliError');
};

describe('diagnostics', () => {
  it('prints file:line:col with 1-based positions', () => {
    const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } };
    expect(formatDiagnostic('a.yaml', { severity: 'error', code: 'x', message: 'Bad.', range })).toBe(
      'a.yaml:3:5 error Bad.',
    );
    expect(formatDiagnostic('a.yaml', { severity: 'warning', code: 'x', message: 'Hmm.' })).toBe(
      'a.yaml warning Hmm.',
    );
  });

  it('shows paths relative to the current folder when they are inside it', () => {
    expect(displayPath(path.join(root, 'a', 'b.yaml'), root)).toBe(path.join('a', 'b.yaml'));
    expect(displayPath(path.join(root, 'b.yaml'), path.join(root, 'sub'))).toBe(path.join(root, 'b.yaml'));
  });
});

describe('readTextFile', () => {
  it('reads UTF-8 without a byte order mark, undefined when missing', async () => {
    writeFile(root, 'bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('häh')]));
    expect(await readTextFile(path.join(root, 'bom.txt'))).toBe('häh');
    expect(await readTextFile(path.join(root, 'missing.txt'))).toBeUndefined();
  });

  it('explains other read errors', async () => {
    const error = await thrown(readTextFile(root));
    expect(error.message).toMatch(/^Could not read .+: /);
  });
});

describe('checkWorkflow', () => {
  const valid = 'version: 1\nname: Build\nsteps:\n  - id: build\n    type: console\n    run: npm test\n';

  it('returns a valid workflow', () => {
    expect(checkWorkflow(valid, 'w.yaml', {}).workflow.name).toBe('Build');
  });

  it('refuses a workflow with errors and lists them', () => {
    const error = thrown(() =>
      checkWorkflow('version: 1\nname: Build\nsteps:\n  - id: x\n    type: nope\n', 'w.yaml', {}),
    );
    return error.then((e) => {
      expect(e.message).toMatch(/^The workflow has \d+ errors?\. Fix (it|them) and run again\.$/);
      expect(e.details[0]).toMatch(/^w\.yaml:5:\d+ error /);
    });
  });

  it('refuses an empty file', async () => {
    const error = await thrown(() => checkWorkflow('', 'w.yaml', {}));
    expect(error.message).toMatch(/The workflow has 1 error/);
  });

  it('notes that user agents are not available for unknown agents', async () => {
    const text =
      'version: 1\nname: Fix\nsteps:\n  - id: fix\n    type: agent\n    agent: coder\n    prompt: Fix it\n';
    const error = await thrown(() => checkWorkflow(text, 'w.yaml', { agentIds: [] }));
    expect(error.details.join('\n')).toContain(
      "User agents from VS Code aren't available on the command line. Copy the agent file into .isarflow/agents/.",
    );
  });

  it('turns unknown secrets into warnings that name the environment variable', () => {
    const text =
      'version: 1\nname: Deploy\nsteps:\n  - id: d\n    type: console\n    run: echo ${{ secrets.api_token }}\n';
    const { warnings } = checkWorkflow(text, 'w.yaml', { secretNames: [] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^w\.yaml:6:\d+ warning /);
    expect(warnings[0]).toContain(
      "isn't set. Set the environment variable ISARFLOW_SECRET_API_TOKEN or fix the name.",
    );
  });
});

describe('loadAgents', () => {
  it('reads the agent files of the workspace and skips invalid ones with a warning', async () => {
    writeFile(root, '.isarflow/agents/coder.agent.yaml', 'name: Coder\nmodel: local/qwen\n');
    writeFile(root, '.isarflow/agents/writer.agent.yml', 'name: Writer\nmodel: local/qwen\n');
    writeFile(root, '.isarflow/agents/broken.agent.yaml', 'name: Broken\nmodel: 42\ncolor: red\n');
    writeFile(root, '.isarflow/agents/notes.md', '# not an agent');
    const { agents, warnings } = await loadAgents(root, root);
    expect(Object.keys(agents).sort()).toEqual(['coder', 'writer']);
    expect(agents.coder).toMatchObject({ name: 'Coder', model: 'local/qwen' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/broken\.agent\.yaml:\d+:\d+ warning Skipped this agent: /);
  });

  it('keeps the first of two files with the same id', async () => {
    writeFile(root, '.isarflow/agents/coder.agent.yaml', 'name: First\nmodel: local/a\n');
    writeFile(root, '.isarflow/agents/coder.agent.yml', 'name: Second\nmodel: local/b\n');
    const { agents, warnings } = await loadAgents(root, root);
    expect(agents.coder.name).toBe('First');
    expect(warnings[0]).toContain(
      "coder.agent.yml warning Skipped this agent: coder.agent.yaml has the same id 'coder'.",
    );
  });

  it('has no agents without the folder', async () => {
    expect(await loadAgents(root, root)).toEqual({ agents: {}, warnings: [] });
  });
});

describe('loadProjectConfig', () => {
  it('is empty without a config file', async () => {
    expect(await loadProjectConfig(root, root)).toEqual({ config: {} });
  });

  it('reads the providers', async () => {
    const file = writeFile(
      root,
      '.isarflow/config.yaml',
      'version: 1\nproviders:\n  - id: local\n    baseUrl: http://localhost:11434/v1\n',
    );
    expect(await loadProjectConfig(root, root)).toEqual({
      config: { version: 1, providers: [{ id: 'local', baseUrl: 'http://localhost:11434/v1' }] },
      file,
    });
  });

  it('refuses an API key in the file and points to apiKeyEnv', async () => {
    writeFile(
      root,
      '.isarflow/config.yaml',
      'providers:\n  - id: local\n    baseUrl: http://localhost:4000\n    apiKey: sk-123\n',
    );
    const error = await thrown(loadProjectConfig(root, root));
    expect(error.message).toBe('The config file has 1 error. Fix it and run again.');
    expect(error.details[0]).toMatch(/config\.yaml:4:\d+ error .*apiKeyEnv/);
  });
});

describe('loadSimulation', () => {
  const workflow = {
    version: 1 as const,
    name: 'W',
    steps: [{ id: 'build', type: 'console' as const, run: 'x' }],
  };
  const workflowFile = () => path.join(root, '.isarflow', 'workflows', 'ship it.workflow.yaml');

  it('uses the block defaults without a simulation file', async () => {
    expect(await loadSimulation(root, workflowFile(), workflow, root)).toEqual({ file: {}, warnings: [] });
  });

  it('reads the simulation file of the workflow and warns about mocks that do not fit', async () => {
    const file = writeFile(
      root,
      '.isarflow/simulations/ship it.sim.yml',
      'blocks:\n  build:\n    - exitCode: 1\n  ghost:\n    - exitCode: 0\n',
    );
    const loaded = await loadSimulation(root, workflowFile(), workflow, root);
    expect(loaded.path).toBe(file);
    expect(loaded.file.blocks?.build).toEqual([{ exitCode: 1 }]);
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain('warning No block "ghost"');
  });

  it('refuses a simulation file with errors', async () => {
    writeFile(root, '.isarflow/simulations/ship it.sim.yaml', 'blocks:\n  build:\n    - exitCode: nope\n');
    const error = await thrown(loadSimulation(root, workflowFile(), workflow, root));
    expect(error.message).toBe('The simulation file has 1 error. Fix it and run again.');
    expect(error.details[0]).toMatch(/ship it\.sim\.yaml:3:\d+ error /);
  });
});
