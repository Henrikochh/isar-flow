const lines = (...text: string[]) => `${text.join('\n')}\n`;

/** Text of a new simulation file: how mocks work, a commented example per block type, and no mocks yet. */
export function newSimulationText(workflowName: string): string {
  const name = workflowName.replace(/\s+/g, ' ').trim();
  const subject = name === '' ? 'this workflow' : `the workflow "${name}"`;
  return lines(
    `# Mocks for ${subject}. Simulate uses them instead of running commands, calling models or asking you.`,
    '# List results per block id under "blocks". Each call of a block takes the next result; the last one repeats.',
    '# Blocks without mocks get defaults: console blocks exit with 0 and print nothing, agents answer',
    '# "(simulated answer)" or sample JSON built from their JSON fields, and approvals are approved',
    '# (add "approvals: reject" to reject them). Any result can fail the call with "error".',
    '#',
    '# Example:',
    '# blocks:',
    '#   tests: # console block',
    '#     - exitCode: 1',
    '#       output: 1 failed',
    '#     - exitCode: 0',
    '#   implement: # agent block that answers with text',
    '#     - text: Implemented the login form.',
    '#   review: # agent block that answers with JSON',
    '#     - json: { approved: false, issues: [Add a test for the error case] }',
    '#     - json: { approved: true, issues: [] }',
    '#   ship: # approval block',
    '#     - approved: true',
    '#       comment: Looks good',
    '#   deploy: # any block: the call fails',
    '#     - error: The server is not reachable.',
    '',
    'version: 1',
    'blocks: {}',
  );
}
