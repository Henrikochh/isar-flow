import type { Diagnostic, DiagnosticSeverity } from './diagnostics';
import {
  analyzeExpression,
  compileRegex,
  type Expr,
  FUNCTION_NAMES,
  findTemplateExpressions,
  parseExpression,
} from './expr';
import type { Workflow } from './schema/types';
import {
  type BlockNode,
  canReadBlock,
  hasLoopScope,
  inDifferentBranches,
  isRecord,
  listBlocks,
} from './variables';

export interface ValidateOptions {
  /** Known agent ids; unknown `agent` ids are errors. Omit to skip the check. */
  agentIds?: string[];
  /** Available model refs; unknown models are warnings. Omit or pass [] to skip the check. */
  modelRefs?: string[];
  /** Stored secret names; unknown `secrets.<name>` are warnings. Omit to skip the check. */
  secretNames?: string[];
}

type Path = (string | number)[];

/** A field holding templates or conditions, and the block it belongs to (null for workflow-level fields). */
interface Site {
  path: Path;
  block: BlockNode | null;
}

const KNOWN_ROOTS = ['inputs', 'steps', 'env', 'loop', 'workflow', 'workspace', 'run', 'secrets'];
const REGEX_OPS = new Set(['matches', 'notMatches']);
/** Workflow env is merged into `env.*` once, before the first block (see RunOptions.env). */
const RUN_START = 'workflow env is set once when the run starts, before any block runs';

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const blockName = (node: BlockNode) => (node.id ? `'${node.id}'` : 'a block without id');
const at = (site: Site, ...keys: (string | number)[]): Site => ({
  path: [...site.path, ...keys],
  block: site.block,
});

/** Field name relative to its block, e.g. 'until.any[1].value'. */
function fieldLabel(site: Site): string {
  const rel = site.path.slice(site.block ? site.block.path.length : 0);
  return rel.map((seg, i) => (typeof seg === 'number' ? `[${seg}]` : i === 0 ? seg : `.${seg}`)).join('');
}

function where(site: Site): string {
  return `${fieldLabel(site)} of ${site.block ? blockName(site.block) : 'the workflow'}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Text after the last ': ', which is where the JS engine puts the reason of a RegExp error. */
function regexReason(error: unknown): string {
  const message = errorMessage(error);
  return message.slice(message.lastIndexOf(': ') + 2) || message;
}

export function validateWorkflow(workflow: Workflow, options: ValidateOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const reported = new Set<string>();
  const blocks = listBlocks(workflow);
  const byId = new Map<string, BlockNode[]>();
  for (const block of blocks) {
    if (block.id) byId.set(block.id, [...(byId.get(block.id) ?? []), block]);
  }
  const inputs = isRecord(workflow.inputs) ? workflow.inputs : {};
  const modelRefs = options.modelRefs?.length ? new Set(options.modelRefs) : undefined;

  const report = (
    code: string,
    severity: DiagnosticSeverity,
    message: string,
    path: Path,
    block: BlockNode | null,
  ) => {
    const key = `${code}\u0000${message}\u0000${path.join('\u0000')}`;
    if (reported.has(key)) return;
    reported.add(key);
    const diagnostic: Diagnostic = { severity, message, code, path };
    if (block?.id) diagnostic.stepId = block.id;
    diagnostics.push(diagnostic);
  };
  const reportAt = (site: Site, code: string, severity: DiagnosticSeverity, message: string) =>
    report(code, severity, message, site.path, site.block);

  const checkRegex = (pattern: unknown, flags: unknown, site: Site) => {
    try {
      compileRegex(pattern, flags);
    } catch (e) {
      const source = typeof pattern === 'string' ? pattern : String(pattern);
      const fix = flags == null || flags === '' ? 'Fix the pattern.' : 'Fix the pattern or its flags.';
      reportAt(
        site,
        'invalid-regex',
        'error',
        `Invalid regular expression '${source}' in ${where(site)}: ${regexReason(e)}. ${fix}`,
      );
    }
  };

  // matches(text, 'literal pattern', 'literal flags'?) can be checked before the run.
  const checkRegexCalls = (expr: Expr, site: Site): void => {
    const children: Expr[] = [];
    switch (expr.kind) {
      case 'call': {
        const [, pattern, flags] = expr.args;
        if (expr.callee === 'matches' && pattern?.kind === 'literal' && typeof pattern.value === 'string') {
          checkRegex(pattern.value, flags?.kind === 'literal' ? flags.value : '', site);
        }
        children.push(...expr.args);
        break;
      }
      case 'member':
        children.push(expr.object, expr.property);
        break;
      case 'array':
        children.push(...expr.elements);
        break;
      case 'unary':
        children.push(expr.arg);
        break;
      case 'binary':
      case 'logical':
        children.push(expr.left, expr.right);
        break;
      case 'conditional':
        children.push(expr.test, expr.consequent, expr.alternate);
        break;
    }
    children.forEach((child) => checkRegexCalls(child, site));
  };

  const whyNotRun = (target: BlockNode, from: BlockNode): string => {
    const name = blockName(target);
    if (from.ancestors.includes(target))
      return `${name} contains ${blockName(from)} and only finishes after it`;
    // Loops can read their body, so a descendant that is not readable sits in a branch of an if.
    if (target.ancestors.includes(from)) return `${name} only runs after this condition is checked`;
    if (inDifferentBranches(target, from)) {
      const shared = target.ancestors.filter((a) => from.ancestors.includes(a));
      const owner = shared[shared.length - 1];
      return `${name} is in the other branch of ${owner ? blockName(owner) : 'the same if block'}`;
    }
    return `${name} comes later in the workflow`;
  };

  const checkStepReference = (path: string[], site: Site) => {
    const id = path[1];
    const ref = `steps.${id}`;
    const targets = byId.get(id);
    if (!targets) {
      reportAt(
        site,
        'unknown-step-reference',
        'error',
        `${ref} in ${where(site)} points to a block that does not exist. Check the block id.`,
      );
      return;
    }
    const target = targets[0];
    if (path[2] === 'json' && target.step.type === 'agent') {
      const output = isRecord(target.step.output) ? target.step.output : undefined;
      if (output?.format !== 'json') {
        reportAt(
          site,
          'json-field-without-json-output',
          'warning',
          `${ref}.json in ${where(site)} is only set when ${blockName(target)} uses output format JSON. ` +
            `Switch ${blockName(target)} to JSON output or read ${ref}.text instead.`,
        );
      }
    }
    const from = site.block;
    if (!from) {
      reportAt(
        site,
        'forward-reference',
        'warning',
        `${ref} is read in ${where(site)}, but ${RUN_START}, so the value will be empty there. ` +
          'Set the variable in the env of the console block that needs it instead.',
      );
      return;
    }
    if (targets.some((t) => canReadBlock(from, t))) return;
    if (targets.includes(from)) {
      reportAt(
        site,
        'self-reference',
        'error',
        `${blockName(from)} reads its own outputs (${ref}) in ${fieldLabel(site)}, but they are only set after it finishes. ` +
          'Use outputs of an earlier block instead.',
      );
      return;
    }
    reportAt(
      site,
      'forward-reference',
      'warning',
      `${ref} is read in ${where(site)}, but ${whyNotRun(target, from)}, so the value will be empty there.`,
    );
  };

  const checkReference = (path: string[], site: Site) => {
    const [root, key] = path;
    switch (root) {
      case 'steps':
        if (key !== undefined) checkStepReference(path, site);
        return;
      case 'inputs':
        if (key !== undefined && !Object.hasOwn(inputs, key)) {
          reportAt(
            site,
            'unknown-input',
            'error',
            `inputs.${key} in ${where(site)} is not a declared input. Add '${key}' under inputs or fix the name.`,
          );
        }
        return;
      case 'secrets':
        if (key !== undefined && options.secretNames && !options.secretNames.includes(key)) {
          reportAt(
            site,
            'unknown-secret',
            'warning',
            `secrets.${key} in ${where(site)} is not a stored secret. Store the secret or fix the name.`,
          );
        }
        return;
      case 'loop':
        if (!site.block) {
          reportAt(
            site,
            'loop-variable-outside-loop',
            'error',
            `${path.join('.')} in ${where(site)} only works inside a loop, but ${RUN_START}. ` +
              'Set the variable in the env of a console block inside the loop instead.',
          );
        } else if (!hasLoopScope(site.block)) {
          reportAt(
            site,
            'loop-variable-outside-loop',
            'error',
            `${path.join('.')} in ${where(site)} only works inside a loop. Move the block into a loop or remove the reference.`,
          );
        }
        return;
      case 'env':
      case 'workflow':
      case 'workspace':
      case 'run':
        return;
      default: {
        const hint = byId.has(root) ? ` Did you mean '${['steps', ...path].join('.')}'?` : '';
        reportAt(
          site,
          'unknown-root',
          'warning',
          `'${root}' in ${where(site)} is not a known name. Expressions can read ${KNOWN_ROOTS.join(', ')}.${hint}`,
        );
      }
    }
  };

  const checkExpression = (src: string, site: Site) => {
    let expr: Expr;
    try {
      expr = parseExpression(src);
    } catch (e) {
      reportAt(
        site,
        'expression-syntax',
        'error',
        `Invalid expression '${src}' in ${where(site)}: ${errorMessage(e)}.`,
      );
      return;
    }
    const { references, functions } = analyzeExpression(src);
    for (const name of functions) {
      if (!FUNCTION_NAMES.includes(name)) {
        reportAt(
          site,
          'unknown-function',
          'error',
          `Unknown function '${name}' in ${where(site)}. Available functions: ${FUNCTION_NAMES.join(', ')}.`,
        );
      }
    }
    checkRegexCalls(expr, site);
    for (const path of references) checkReference(path, site);
  };

  const checkTemplate = (text: unknown, site: Site) => {
    if (typeof text !== 'string' || !text.includes('${{')) return;
    let matches;
    try {
      matches = findTemplateExpressions(text);
    } catch (e) {
      reportAt(
        site,
        'expression-syntax',
        'error',
        `Invalid expression in ${where(site)}: ${errorMessage(e)}. Close it with }}.`,
      );
      return;
    }
    for (const match of matches) checkExpression(match.expr, site);
  };

  const checkComparison = (cond: Record<string, unknown>, site: Site) => {
    const { value, to, op } = cond;
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      const valueSite = value === undefined ? site : at(site, 'value');
      reportAt(
        valueSite,
        'missing-condition-value',
        'warning',
        `A comparison in ${where(site)} has no value to compare. Pick a value, e.g. \${{ steps.tests.exitCode }}.`,
      );
    } else {
      checkTemplate(value, at(site, 'value'));
    }
    if (typeof to === 'string' && to.includes('${{')) checkTemplate(to, at(site, 'to'));
    else if (typeof op === 'string' && REGEX_OPS.has(op) && typeof to === 'string')
      checkRegex(to, '', at(site, 'to'));
  };

  const checkCondition = (cond: unknown, site: Site): void => {
    if (typeof cond === 'string') {
      // Mirrors evaluateCondition: templates when present, otherwise the whole string is one expression.
      if (cond.includes('${{')) checkTemplate(cond, site);
      else if (cond.trim() !== '') checkExpression(cond, site);
      else {
        reportAt(
          site,
          'expression-syntax',
          'error',
          `The ${where(site)} is empty. Write a condition, e.g. \${{ steps.tests.exitCode == 0 }}.`,
        );
      }
      return;
    }
    if (!isRecord(cond)) return;
    if ('all' in cond || 'any' in cond) {
      const key = 'all' in cond ? 'all' : 'any';
      const list = cond[key];
      if (Array.isArray(list)) list.forEach((c, i) => checkCondition(c, at(site, key, i)));
    } else if ('not' in cond) {
      checkCondition(cond.not, at(site, 'not'));
    } else if ('op' in cond) {
      checkComparison(cond, site);
    }
  };

  const checkModel = (model: unknown, path: Path, block: BlockNode) => {
    if (!modelRefs || typeof model !== 'string' || modelRefs.has(model)) return;
    report(
      'unknown-model',
      'warning',
      `Model '${model}' used by ${blockName(block)} is not available. Refresh the model list or pick another model.`,
      path,
      block,
    );
  };

  const checkAgentBlock = (block: BlockNode, step: Record<string, unknown>) => {
    const { agent, model } = step;
    const hasStepModel = nonEmpty(model);
    if (!nonEmpty(agent) && !isRecord(agent) && !hasStepModel) {
      const subject = block.id ? `block '${block.id}'` : 'this block';
      report('agent-missing', 'error', `Choose an agent or a model for ${subject}.`, block.path, block);
    } else if (isRecord(agent) && !nonEmpty(agent.model) && !hasStepModel) {
      report(
        'agent-missing',
        'error',
        `Choose a model for ${blockName(block)}: its inline agent has no model.`,
        [...block.path, 'agent'],
        block,
      );
    }
    if (nonEmpty(agent) && options.agentIds && !options.agentIds.includes(agent)) {
      report(
        'unknown-agent',
        'error',
        `Agent '${agent}' used by ${blockName(block)} was not found. Create it in the Agents view or pick an existing agent.`,
        [...block.path, 'agent'],
        block,
      );
    }
    checkModel(model, [...block.path, 'model'], block);
    if (isRecord(agent)) {
      checkModel(agent.model, [...block.path, 'agent', 'model'], block);
      if (Array.isArray(agent.fallbackModels)) {
        agent.fallbackModels.forEach((m, i) =>
          checkModel(m, [...block.path, 'agent', 'fallbackModels', i], block),
        );
      }
    }
    checkTemplate(step.prompt, { path: [...block.path, 'prompt'], block });
    // The engine renders context file globs like the prompt.
    const files = isRecord(step.context) ? step.context.files : undefined;
    if (Array.isArray(files)) {
      files.forEach((file, i) =>
        checkTemplate(file, { path: [...block.path, 'context', 'files', i], block }),
      );
    }
  };

  const checkBlock = (block: BlockNode) => {
    const step = block.step as unknown as Record<string, unknown>;
    const site = (...keys: (string | number)[]): Site => ({ path: [...block.path, ...keys], block });
    switch (block.step.type) {
      case 'agent':
        checkAgentBlock(block, step);
        break;
      case 'console':
        checkTemplate(step.run, site('run'));
        checkTemplate(step.cwd, site('cwd'));
        if (isRecord(step.env))
          for (const [key, value] of Object.entries(step.env)) checkTemplate(value, site('env', key));
        break;
      case 'loop': {
        const body = step.steps;
        if (!Array.isArray(body) || body.length === 0) {
          const path = Array.isArray(body) ? site('steps').path : block.path;
          report(
            'empty-loop',
            'warning',
            `Loop ${blockName(block)} has no blocks to repeat. Add blocks inside it.`,
            path,
            block,
          );
        }
        if (step.until !== undefined) checkCondition(step.until, site('until'));
        if (step.while !== undefined) checkCondition(step.while, site('while'));
        break;
      }
      case 'if': {
        const isEmpty = (list: unknown) => !Array.isArray(list) || list.length === 0;
        if (isEmpty(step.then) && isEmpty(step.else)) {
          report(
            'empty-if',
            'warning',
            `If block ${blockName(block)} has no blocks in either branch. Add blocks to then or else.`,
            block.path,
            block,
          );
        }
        checkCondition(step.condition, site('condition'));
        break;
      }
      case 'break':
        if (!block.ancestors.some((a) => a.step.type === 'loop')) {
          report(
            'break-outside-loop',
            'error',
            `Break block ${blockName(block)} is not inside a loop, so there is nothing to leave. Move it into a loop or remove it.`,
            block.path,
            block,
          );
        }
        break;
      case 'stop':
      case 'approval':
        checkTemplate(step.message, site('message'));
        break;
    }
  };

  if (isRecord(workflow.env)) {
    for (const [key, value] of Object.entries(workflow.env))
      checkTemplate(value, { path: ['env', key], block: null });
  }

  const seenIds = new Set<string>();
  for (const block of blocks) {
    if (block.id && seenIds.has(block.id)) {
      report(
        'duplicate-id',
        'error',
        `The id '${block.id}' is used by more than one block. Give each block a unique id.`,
        [...block.path, 'id'],
        block,
      );
    }
    if (block.id) seenIds.add(block.id);
    checkBlock(block);
  }
  return diagnostics;
}
