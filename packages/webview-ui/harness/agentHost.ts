/** Agent editor side of the mock host: the agent file, Try it, "Test model" and the project memory file. */
import {
  applyAgentUpdate,
  newAgentText,
  parseAgentText,
  type AgentDocumentState,
  type AgentEditorToHost,
  type HostToAgentEditor,
  type MemoryFileState,
  type ModelCatalog,
} from '@isar-flow/core';
import { CATALOG, MEMORY_FILE, MEMORY_MISSING, MEMORY_OVER, REVIEWER_AGENT_TEXT } from './fixtures';
import { markReady, probe, sleep, testModel, type Send } from './mockShared';

/** A model whose cached probe says it needs text tool mode (scenarios 'probed' and 'textmode'). */
const TEXT_MODE_MODEL = 'litellm/llama-3.3-70b';

function scenarioAgentText(scenario: string): string {
  switch (scenario) {
    case 'new':
      return newAgentText('Translator');
    case 'invalid':
      return REVIEWER_AGENT_TEXT.replace('temperature: 0.2', 'temperature: 3').replace(
        'edits: none',
        'edits: sometimes',
      );
    // Tools that need permissions, but no levels set: the editor shows the effective "Ask".
    case 'noperms':
      return REVIEWER_AGENT_TEXT.replace('gitDiff]', 'gitDiff, editFile, runCommand]').replace(
        /permissions:\n( {2}.*\n)+/,
        '',
      );
    case 'long':
      return REVIEWER_AGENT_TEXT.replace(
        'name: Reviewer',
        'name: Security and dependency upgrade reviewer for payments',
      )
        .replace(
          'description: Strict senior code reviewer',
          'description: Checks every dependency bump for breaking changes, licence problems and known vulnerabilities before it is merged',
        )
        .replace(
          'model: vscode/copilot/gpt-4.1',
          'model: litellm/anthropic.claude-sonnet-4-20250514-v1:0-eu-central-1',
        )
        .replace(
          '  - litellm/claude-sonnet',
          '  - litellm/claude-sonnet\n  - openrouter/meta-llama/llama-3.3-70b-instruct:free\n  - ollama/qwen2.5-coder:32b',
        );
    // The agent's model has a cached "Needs text tool mode" probe; 'textmode' also sets the agent to it.
    case 'probed':
      return REVIEWER_AGENT_TEXT.replace('model: vscode/copilot/gpt-4.1', `model: ${TEXT_MODE_MODEL}`);
    case 'textmode':
      return scenarioAgentText('probed').replace('gitDiff]\n', 'gitDiff]\ntoolMode: text\n');
    // An agent that keeps notes: it reads the memory file and may add to it.
    case 'memory':
    case 'memory-over':
      return `${REVIEWER_AGENT_TEXT}memory: write\n`;
    default:
      return REVIEWER_AGENT_TEXT;
  }
}

/** The memory file the host reports for the agent: none without a folder, missing, too long, or a few notes. */
function scenarioMemory(scenario: string): MemoryFileState | null {
  if (scenario === 'memory-nofolder') return null;
  if (scenario === 'memory-missing') return MEMORY_MISSING;
  if (scenario === 'memory-over') return MEMORY_OVER;
  return MEMORY_FILE;
}

export function agentHost(scenario: string, send: Send<HostToAgentEditor>) {
  let text = scenarioAgentText(scenario);
  const userScope = scenario === 'memory-user';
  const openedMemory: (string | null)[] = [];
  probe.openedMemory = () => openedMemory;
  const id =
    scenario === 'new'
      ? 'translator'
      : scenario === 'long'
        ? 'security-and-dependency-upgrade-reviewer'
        : 'reviewer';
  const usedBy =
    scenario === 'long'
      ? [
          '.isarflow/workflows/nightly/upgrade-dependencies-and-fix-everything.workflow.yaml',
          '.isarflow/workflows/review-loop.workflow.yaml',
        ]
      : id === 'reviewer'
        ? ['.isarflow/workflows/review-loop.workflow.yaml']
        : [];
  probe.agentText = () => text;
  let streaming: { cancelled: boolean } | undefined;
  let catalog: ModelCatalog = CATALOG;
  const sendCatalog = () => send({ type: 'catalog', catalog });

  const doc = (): AgentDocumentState => {
    const parsed = parseAgentText(text);
    return {
      uri: userScope
        ? `file:///c%3A/Users/me/.isarflow/agents/${id}.agent.yaml`
        : `file:///c%3A/work/shop/.isarflow/agents/${id}.agent.yaml`,
      id,
      scope: userScope ? 'user' : 'workspace',
      fileName: `${id}.agent.yaml`,
      text,
      agent: parsed.agent,
      valid: parsed.valid,
      diagnostics: parsed.diagnostics,
      usedBy,
    };
  };

  const answer = async (prompt: string) => {
    const run = { cancelled: false };
    streaming = run;
    send({
      type: 'tryItEvent',
      event: {
        type: 'tool',
        name: 'gitDiff',
        args: '{}',
        result: '3 files changed, 48 insertions(+), 6 deletions(-)',
      },
    });
    await sleep(300);
    const reply = `{\n  "approved": false,\n  "issues": [\n    "applyVoucher() runs twice when the cart is re-validated",\n    "No test covers expired vouchers"\n  ]\n}`;
    for (const chunk of reply.match(/.{1,6}/gs) ?? []) {
      if (run.cancelled) return;
      send({ type: 'tryItEvent', event: { type: 'text', text: chunk } });
      await sleep(20);
    }
    void prompt;
    send({
      type: 'tryItEvent',
      event: {
        type: 'done',
        usage: { inputTokens: 4210, outputTokens: 96 },
        model: 'vscode/copilot/gpt-4.1',
      },
    });
  };

  return (message: AgentEditorToHost) => {
    switch (message.type) {
      case 'ready':
        send({ type: 'document', doc: doc() });
        sendCatalog();
        send({ type: 'memory', memory: scenarioMemory(scenario) });
        markReady();
        break;
      case 'update': {
        const result = applyAgentUpdate(text, message.set as Record<string, unknown>, message.unset);
        if (result.error) send({ type: 'updateFailed', error: result.error });
        else {
          text = result.text;
          send({ type: 'document', doc: doc() });
        }
        break;
      }
      case 'tryIt':
        void answer(message.prompt);
        break;
      case 'cancelTryIt':
        if (streaming) streaming.cancelled = true;
        break;
      case 'testModel':
        testModel(
          message.ref,
          () => catalog,
          (next) => {
            catalog = next;
            sendCatalog();
          },
        );
        break;
      // The extension opens (or creates) the file in an editor; the harness only notes the request.
      case 'openMemory':
        openedMemory.push(null);
        break;
      default:
        console.info('[mock host] agent message', message);
    }
  };
}
