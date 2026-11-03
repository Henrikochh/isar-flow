import { z } from 'zod';
import type { Condition } from '../conditions';
import { CONDITION_OPS } from '../conditions';
import type { AgentDefinition, Step, Workflow } from './types';

export const STEP_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const ToolNameSchema = z.enum([
  'readFile',
  'listFiles',
  'searchText',
  'gitDiff',
  'editFile',
  'applyPatch',
  'writeFile',
  'runCommand',
]);
const PermissionSchema = z.enum(['none', 'ask', 'auto']);
const ToolModeSchema = z.enum(['auto', 'native', 'text']).meta({
  description:
    'How the agent calls tools: auto (native tool calls when the model supports them, otherwise text), ' +
    'native (native tool calls only) or text (tools described in the prompt, for models without tool calling).',
});
const ModelRefSchema = z
  .string()
  .regex(/^[^/\s]+\/\S+$/, 'Model must look like "<provider>/<model>", e.g. "litellm/gpt-4.1"')
  .meta({
    description: 'Model reference "<provider>/<model>", e.g. "litellm/gpt-4.1" or "vscode/copilot/gpt-4.1".',
  });

const AgentSettingsShape = {
  model: ModelRefSchema.optional(),
  fallbackModels: z
    .array(ModelRefSchema)
    .optional()
    .meta({ description: 'Models tried when the main model fails.' }),
  systemPrompt: z
    .string()
    .optional()
    .meta({ description: 'Instructions that define how the agent behaves.' }),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  maxTurns: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .meta({ description: 'Maximum tool-calling rounds (default 20).' }),
  tools: z.array(ToolNameSchema).optional().meta({ description: 'Built-in tools the agent may use.' }),
  toolMode: ToolModeSchema.optional(),
  permissions: z
    .strictObject({ edits: PermissionSchema.optional(), commands: PermissionSchema.optional() })
    .optional()
    .meta({ description: 'none = never, ask = confirm each time, auto = allow.' }),
};

export const AgentSettingsSchema = z.strictObject(AgentSettingsShape);

export const AgentDefinitionSchema: z.ZodType<AgentDefinition> = z.strictObject({
  ...AgentSettingsShape,
  name: z.string().min(1).meta({ description: 'Display name of the agent.' }),
  description: z.string().optional(),
  model: ModelRefSchema,
});

const ConditionOpSchema = z.enum(CONDITION_OPS.map((o) => o.op) as [string, ...string[]]);

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.string().min(1).meta({ description: 'Expression, e.g. "${{ steps.tests.exitCode == 0 }}"' }),
    z.strictObject({ all: z.array(ConditionSchema) }),
    z.strictObject({ any: z.array(ConditionSchema) }),
    z.strictObject({ not: ConditionSchema }),
    z.strictObject({
      value: z.unknown(),
      op: ConditionOpSchema,
      to: z.unknown().optional(),
      ignoreCase: z.boolean().optional(),
    }),
  ]),
) as z.ZodType<Condition>;

const base = {
  id: z
    .string()
    .regex(STEP_ID_PATTERN, 'Block ids start with a letter or _ and contain only letters, digits, _ and -')
    .meta({ description: 'Unique id, used to reference outputs as steps.<id>.' }),
  name: z.string().optional().meta({ description: 'Display label on the canvas.' }),
  timeout: z.number().positive().optional().meta({ description: 'Timeout in seconds.' }),
  continueOnError: z.boolean().optional(),
  retry: z
    .strictObject({ max: z.number().int().min(1).max(10), delay: z.number().min(0).optional() })
    .optional()
    .meta({ description: 'Retry failed attempts; delay in seconds.' }),
};

const StepList: z.ZodType<Step[]> = z.lazy(() => z.array(StepSchema));

const AgentStepSchema = z.strictObject({
  ...base,
  type: z.literal('agent'),
  agent: z
    .union([z.string().min(1), AgentSettingsSchema])
    .optional()
    .meta({ description: 'Agent id or inline agent settings.' }),
  model: ModelRefSchema.optional(),
  prompt: z.string().meta({ description: 'Task for the agent. Supports ${{ }} templates.' }),
  output: z
    .strictObject({ format: z.enum(['text', 'json']), schema: z.record(z.string(), z.unknown()).optional() })
    .optional(),
  session: z.enum(['fresh', 'continue']).optional(),
  context: z.strictObject({ files: z.array(z.string()).optional() }).optional(),
});

const ConsoleStepSchema = z.strictObject({
  ...base,
  type: z.literal('console'),
  run: z.string().min(1).meta({ description: 'Command line to run. Supports ${{ }} templates.' }),
  shell: z.enum(['auto', 'pwsh', 'powershell', 'cmd', 'bash', 'sh']).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const LoopStepSchema = z
  .strictObject({
    ...base,
    type: z.literal('loop'),
    until: ConditionSchema.optional().meta({
      description: 'Checked after each iteration; the loop ends when true.',
    }),
    while: ConditionSchema.optional().meta({
      description: 'Checked before each iteration; the loop ends when false.',
    }),
    maxIterations: z.number().int().min(1).max(100).meta({ description: 'Safety limit (1–100).' }),
    onMaxIterations: z.enum(['fail', 'continue']).optional(),
    steps: StepList,
  })
  .refine((s) => !(s.until !== undefined && s.while !== undefined), {
    message: 'Use either "until" or "while", not both',
    path: ['while'],
  });

const IfStepSchema = z.strictObject({
  ...base,
  type: z.literal('if'),
  condition: ConditionSchema,
  then: StepList,
  else: StepList.optional(),
});

const BreakStepSchema = z.strictObject({ ...base, type: z.literal('break') });

const StopStepSchema = z.strictObject({
  ...base,
  type: z.literal('stop'),
  outcome: z.enum(['success', 'failure']).optional(),
  message: z.string().optional(),
});

const ApprovalStepSchema = z.strictObject({
  ...base,
  type: z.literal('approval'),
  message: z.string().min(1),
  onReject: z.enum(['stop', 'continue']).optional(),
});

export const StepSchema: z.ZodType<Step> = z.discriminatedUnion('type', [
  AgentStepSchema,
  ConsoleStepSchema,
  LoopStepSchema,
  IfStepSchema,
  BreakStepSchema,
  StopStepSchema,
  ApprovalStepSchema,
]) as z.ZodType<Step>;

const InputSchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean']).optional(),
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean().optional(),
  multiline: z.boolean().optional(),
});

export const WorkflowSchema: z.ZodType<Workflow> = z.strictObject({
  version: z.literal(1).meta({ description: 'Isar Flow workflow format version.' }),
  name: z.string().min(1),
  description: z.string().optional(),
  inputs: z
    .record(z.string().regex(STEP_ID_PATTERN, 'Input names start with a letter or _'), InputSchema)
    .optional()
    .meta({ description: 'Values asked for when the run starts; referenced as inputs.<name>.' }),
  env: z.record(z.string(), z.string()).optional(),
  isolation: z
    .enum(['workspace', 'worktree'])
    .optional()
    .meta({
      description:
        'Where the run changes files: workspace (default) or worktree (git only: a separate git worktree; ' +
        'you choose which changes to keep).',
    }),
  setup: z
    .array(z.string().min(1, 'Setup commands cannot be empty'))
    .optional()
    .meta({ description: 'Commands run in the worktree before the first block, e.g. "npm ci".' }),
  steps: StepList,
});
