/** Persisted Try it transcript used by the agent editor's "tryit" scenario. */
import type { TranscriptEntry } from '../src/views/agent/transcript';

export type { TranscriptEntry };

export const TRANSCRIPT_FIXTURE: TranscriptEntry[] = [
  { role: 'user', text: 'Review the voucher changes in src/checkout.ts' },
  { role: 'tool', tool: 'gitDiff', text: '', meta: '3 files changed, 48 insertions(+), 6 deletions(-)' },
  { role: 'tool', tool: 'readFile', text: 'src/checkout.ts', meta: '214 lines' },
  {
    role: 'agent',
    text: '{\n  "approved": false,\n  "issues": [\n    "applyVoucher() runs twice when the cart is re-validated",\n    "No test covers expired vouchers"\n  ]\n}',
    meta: 'vscode/copilot/gpt-4.1 · 4.3k tokens',
  },
  { role: 'user', text: 'Which file should the expired-voucher test go into?' },
  { role: 'tool', tool: 'searchText', text: '"applies the voucher once" in src/**/*.test.ts', meta: 'src/checkout.test.ts:88' },
  {
    role: 'agent',
    text: 'Put it in src/checkout.test.ts next to "applies the voucher once". That test already builds a cart with a voucher, so you only need to move the clock past the expiry date.',
    meta: 'vscode/copilot/gpt-4.1 · 4.6k tokens',
  },
];
