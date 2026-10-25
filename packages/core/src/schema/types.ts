import type { Condition } from '../conditions';

export type StepType = 'agent' | 'console' | 'loop' | 'if' | 'break' | 'stop' | 'approval';

export type ToolName = 'readFile' | 'listFiles' | 'searchText' | 'gitDiff' | 'editFile' | 'writeFile' | 'runCommand';

export type PermissionLevel = 'none' | 'ask' | 'auto';

export type ShellName = 'auto' | 'pwsh' | 'powershell' | 'cmd' | 'bash' | 'sh';

export interface AgentPermissions {
  edits?: PermissionLevel;
  commands?: PermissionLevel;
}

/** Agent settings shared by agent files and inline agents in workflow steps. */
export interface AgentSettings {
  model?: string;
  fallbackModels?: string[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  maxTurns?: number;
  tools?: ToolName[];
  permissions?: AgentPermissions;
}

/** Contents of `.isarflow/agents/<id>.agent.yaml`. */
export interface AgentDefinition extends AgentSettings {
  name: string;
  description?: string;
  model: string;
}

/**
 * Expected JSON shape of an agent answer. Either a compact shape (`{ approved: boolean, issues: "string[]" }`)
 * or a full JSON Schema object (detected by a string `type` property).
 */
export type OutputShape = Record<string, unknown>;

export interface StepBase {
  id: string;
  name?: string;
  /** Seconds. */
  timeout?: number;
  continueOnError?: boolean;
  retry?: { max: number; delay?: number };
}

export interface AgentStep extends StepBase {
  type: 'agent';
  agent?: string | AgentSettings;
  model?: string;
  prompt: string;
  output?: { format: 'text' | 'json'; schema?: OutputShape };
  session?: 'fresh' | 'continue';
  context?: { files?: string[] };
}

export interface ConsoleStep extends StepBase {
  type: 'console';
  run: string;
  shell?: ShellName;
  cwd?: string;
  env?: Record<string, string>;
}

export interface LoopStep extends StepBase {
  type: 'loop';
  until?: Condition;
  while?: Condition;
  maxIterations: number;
  onMaxIterations?: 'fail' | 'continue';
  steps: Step[];
}

export interface IfStep extends StepBase {
  type: 'if';
  condition: Condition;
  then: Step[];
  else?: Step[];
}

export interface BreakStep extends StepBase {
  type: 'break';
}

export interface StopStep extends StepBase {
  type: 'stop';
  outcome?: 'success' | 'failure';
  message?: string;
}

export interface ApprovalStep extends StepBase {
  type: 'approval';
  message: string;
  onReject?: 'stop' | 'continue';
}

export type Step = AgentStep | ConsoleStep | LoopStep | IfStep | BreakStep | StopStep | ApprovalStep;

export type StepOfType<T extends StepType> = Extract<Step, { type: T }>;

export interface WorkflowInput {
  type?: 'string' | 'number' | 'boolean';
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
  multiline?: boolean;
}

export interface Workflow {
  version: 1;
  name: string;
  description?: string;
  inputs?: Record<string, WorkflowInput>;
  env?: Record<string, string>;
  steps: Step[];
}

export type StepSlot = 'steps' | 'then' | 'else';
