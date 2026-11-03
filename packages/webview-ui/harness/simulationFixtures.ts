/** Simulation files (`.isarflow/simulations/review-loop.sim.yaml`) of the review-loop workflow for the harness. */

/** Tests fail once, then pass; the reviewer rejects with two issues, then approves; implement and fix use defaults. */
export const SIMULATION_TEXT = `# Mocks for Simulate: results per block, used in order; the last one repeats.
version: 1
approvals: approve
blocks:
  tests:
    - exitCode: 1
      output: 1 failed
    - exitCode: 0
      output: 32 passed
  review:
    - json:
        approved: false
        issues:
          - Voucher is applied twice when the cart is re-validated
          - Missing test for expired vouchers
    - json:
        approved: true
        issues: []
`;

/** Readable, but with warnings: an unknown block, json for a console block and JSON that misses \`issues\`. */
export const SIMULATION_ERRORS_TEXT = `version: 1
blocks:
  deploy:
    - exitCode: 0
  tests:
    - exitCode: 0
      json:
        passed: 32
  review:
    - json:
        approved: true
`;

/** A YAML syntax error: Simulate won't start until it is fixed. */
export const SIMULATION_BROKEN_TEXT = `version: 1
blocks:
  tests:
    - exitCode: 1
      output: 1 failed
  review: [ { json: { approved: true } }
`;
