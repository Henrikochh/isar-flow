/** Persisted Try it transcript used by the agent editor's "tryit" scenario (shape owned by the agent view). */
export interface TranscriptEntry {
  role: 'user' | 'agent' | 'tool' | 'error';
  text: string;
  /** Tool name for role 'tool'. */
  tool?: string;
  /** "4.2k tokens" style footer for finished agent answers. */
  meta?: string;
}

export const TRANSCRIPT_FIXTURE: TranscriptEntry[] = [
  { role: 'user', text: 'Review the voucher changes in src/checkout.ts' },
  { role: 'tool', tool: 'gitDiff', text: '3 files changed, 48 insertions(+), 6 deletions(-)' },
  { role: 'tool', tool: 'readFile', text: 'src/checkout.ts → 214 lines' },
  {
    role: 'agent',
    text: '{\n  "approved": false,\n  "issues": [\n    "applyVoucher() runs twice when the cart is re-validated",\n    "No test covers expired vouchers"\n  ]\n}',
    meta: 'vscode/copilot/gpt-4.1 · 4.3k tokens',
  },
  { role: 'user', text: 'Which file should the expired-voucher test go into?' },
  {
    role: 'agent',
    text: 'Put it in src/checkout.test.ts next to "applies the voucher once" — it already builds a cart with a voucher, so you only need to move the clock past the expiry date.',
    meta: 'vscode/copilot/gpt-4.1 · 4.6k tokens',
  },
];
