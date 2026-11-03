import { describe, expect, it } from 'vitest';
import { HELP_TEXT, parseCliArgs, UsageError } from '../src/args';

const usageError = (argv: string[]): string => {
  try {
    parseCliArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) return error.message;
    throw error;
  }
  throw new Error(`No usage error for ${argv.join(' ')}`);
};

describe('parseCliArgs', () => {
  it('reads the run command with its options', () => {
    expect(
      parseCliArgs(['run', 'fix-tests', '--input', 'branch=main', '--input', 'note=a=b', '--json', '--yes']),
    ).toEqual({
      kind: 'run',
      file: 'fix-tests',
      inputs: { branch: 'main', note: 'a=b' },
      simulate: false,
      json: true,
      yes: true,
    });
    expect(parseCliArgs(['run', '--simulate', 'my flow.workflow.yaml'])).toMatchObject({
      file: 'my flow.workflow.yaml',
      simulate: true,
      json: false,
      yes: false,
      inputs: {},
    });
  });

  it('takes --input name= as an empty value and the last value of a repeated name', () => {
    expect(parseCliArgs(['run', 'x', '--input', 'a=', '--input=b=1', '--input', 'b=2'])).toMatchObject({
      inputs: { a: '', b: '2' },
    });
  });

  it('refuses inputs without a name or an equals sign', () => {
    expect(usageError(['run', 'x', '--input', 'branch'])).toBe(
      "Missing '=' in --input branch. Use --input name=value.",
    );
    expect(usageError(['run', 'x', '--input', '=main'])).toBe(
      'Missing name in --input =main. Use --input name=value.',
    );
    expect(usageError(['run', 'x', '--input'])).toBe('--input needs a value. Use --input name=value.');
  });

  it('shows help and the version', () => {
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['run', '--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['--version'])).toEqual({ kind: 'version' });
  });

  it('refuses unknown commands, including any MCP mode', () => {
    expect(usageError([])).toBe('Missing command. Use isar-flow run <file>.');
    expect(usageError(['mcp'])).toBe("Unknown command 'mcp'. Use isar-flow run <file>.");
    expect(usageError(['serve'])).toBe("Unknown command 'serve'. Use isar-flow run <file>.");
    expect(usageError(['--stdio'])).toBe("Unknown option '--stdio'.");
    expect(usageError(['run', 'x', '--mcp'])).toBe("Unknown option '--mcp'.");
    expect(usageError(['run', 'x', '-y'])).toBe("Unknown option '-y'.");
  });

  it('needs exactly one workflow file', () => {
    expect(usageError(['run'])).toBe('Pass the workflow file to run, e.g. isar-flow run fix-tests.');
    expect(usageError(['run', 'a', 'b'])).toBe("Pass one workflow file; got 'a' and 'b'.");
  });

  it('refuses values for switches', () => {
    expect(usageError(['run', 'x', '--json=yes'])).toBe("--json doesn't take a value.");
  });
});

describe('help text', () => {
  it('lists the options and what the command line cannot do', () => {
    for (const option of ['--input name=value', '--simulate', '--json', '--yes', '--help', '--version']) {
      expect(HELP_TEXT).toContain(option);
    }
    expect(HELP_TEXT).toContain('Usage: isar-flow run <file>');
    expect(HELP_TEXT).toMatch(/VS Code models \(vscode\/…\) and user agents from VS Code/);
    expect(HELP_TEXT).toContain('There is no MCP mode.');
    expect(HELP_TEXT).toContain('ISARFLOW_SECRET_<NAME>');
    for (const line of HELP_TEXT.split('\n')) expect(line.length).toBeLessThanOrEqual(100);
  });
});
