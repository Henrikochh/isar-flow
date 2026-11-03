import { z } from 'zod';
import type { SimulationFile, SimulationResult } from './types';
import { STEP_ID_PATTERN } from './zod';

export const SimulationResultSchema: z.ZodType<SimulationResult> = z.strictObject({
  exitCode: z.number().int().optional().meta({ description: 'Console blocks: exit code (default 0).' }),
  output: z.string().optional().meta({ description: 'Console blocks: what the command printed.' }),
  text: z.string().optional().meta({ description: 'Agent blocks: the answer text.' }),
  json: z.unknown().optional().meta({ description: 'Agent blocks with a JSON answer: the answer.' }),
  approved: z
    .boolean()
    .optional()
    .meta({ description: 'Approval blocks: approve (true) or reject (false).' }),
  comment: z.string().optional().meta({ description: 'Approval blocks: the comment of the decision.' }),
  error: z
    .string()
    .min(1)
    .optional()
    .meta({ description: 'Fails this call with the message, e.g. to simulate an unreachable model.' }),
});

export const SimulationFileSchema: z.ZodType<SimulationFile> = z.strictObject({
  version: z.literal(1).optional().meta({ description: 'Isar Flow simulation file format version.' }),
  approvals: z
    .enum(['approve', 'reject'])
    .optional()
    .meta({ description: 'How approval blocks without mocks are answered (default approve).' }),
  blocks: z
    .record(
      z.string().regex(STEP_ID_PATTERN, 'Block ids start with a letter or _'),
      z.array(SimulationResultSchema).meta({
        description: 'Results for this block, used in order; the last one repeats.',
      }),
    )
    .optional()
    .meta({ description: 'Mocked results per block id.' }),
});
