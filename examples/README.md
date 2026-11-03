# Examples

Ready-made workflows and agents. To use them in a project:

1. Copy the agents you need from `agents/` to `.isarflow/agents/` in your workspace. Workflows refer to an
   agent by its file name without `.agent.yaml`, for example `agent: coder`.
2. Copy a workflow anywhere into the workspace, for example to `.isarflow/workflows/`.
3. Open each agent and pick a model you have. The agents start on `vscode/copilot/gpt-4.1` (GitHub Copilot);
   models of your own endpoints are named like `litellm/gpt-4.1` or `ollama/llama3.1:8b`.
4. Optional: to simulate a workflow before it runs for real, copy its mocks from `.isarflow/simulations/` to
   `.isarflow/simulations/<workflow file name>.sim.yaml` in your workspace and choose **Simulate** in the
   menu of the arrow next to **Run**.
5. Optional: copy `.isarflow/memory.md` as a start for your project memory, and `.isarflow/config.yaml` to
   run workflows from a terminal with `isar-flow run`.

| File                                                                                     | What it does                                                                                                                                                                                              | Agents          |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| [review-loop.workflow.yaml](review-loop.workflow.yaml)                                   | Implements a task, then runs the tests and a JSON review in a loop and fixes what they find, until the tests pass and the reviewer approves (at most 5 rounds).                                           | coder, reviewer |
| [test-fix.workflow.yaml](test-fix.workflow.yaml)                                         | Runs the tests and lets the coder fix failures until they pass (at most 5 rounds).                                                                                                                        | coder           |
| [worktree-fix.workflow.yaml](worktree-fix.workflow.yaml)                                 | Like Test and fix, but on a separate git worktree (`isolation: worktree`) with `npm ci` as setup command. Your files stay untouched until you keep the changes in the review card. Needs git.             | coder           |
| [release-notes.workflow.yaml](release-notes.workflow.yaml)                               | Collects the commits since the last tag, lets the writer draft release notes, asks for your approval and adds them to `RELEASE_NOTES.md`. Uses bash (Git Bash on Windows).                                | writer          |
| [explain-selection.workflow.yaml](explain-selection.workflow.yaml)                       | Explains the code you selected (`editor.selection`, `editor.file`, `editor.language`) and suggests improvements. Start it with **Run workflow on selection** in the editor context menu. Changes nothing. | inline          |
| [tests-on-save.workflow.yaml](tests-on-save.workflow.yaml)                               | Runs the tests whenever you save a TypeScript file (`on: save`) and, when they fail, ends with an explanation that the failure notification shows.                                                        | inline          |
| [deploy.workflow.yaml](deploy.workflow.yaml)                                             | Asks which environment to deploy to (an Ask block with choices, a default and a timeout), asks for approval before production and deploys. `expose: true` lets Copilot run it (`@isarflow /run deploy`).  |                 |
| [agents/coder.agent.yaml](agents/coder.agent.yaml)                                       | Implements tasks and fixes failing tests. Edits files without asking (undoable), asks before running commands.                                                                                            |                 |
| [agents/reviewer.agent.yaml](agents/reviewer.agent.yaml)                                 | Read-only reviewer that answers `{"approved": …, "issues": [...]}`.                                                                                                                                       |                 |
| [agents/writer.agent.yaml](agents/writer.agent.yaml)                                     | Read-only technical writer for release notes and summaries.                                                                                                                                               |                 |
| [.isarflow/simulations/review-loop.sim.yaml](.isarflow/simulations/review-loop.sim.yaml) | Mocks for simulating the review loop: the tests fail and the reviewer asks for changes in round 1; round 2 passes and is approved. Nothing runs and no model is called.                                   |                 |
| [.isarflow/memory.md](.isarflow/memory.md)                                               | An example project memory: short, dated facts that agents with **Memory** set to read see in their instructions, and that agents set to write add with the remember tool.                                 |                 |
| [.isarflow/config.yaml](.isarflow/config.yaml)                                           | Model providers for the command line runner (`isar-flow run`). API keys stay in environment variables (`apiKeyEnv`).                                                                                      |                 |

In the review and test workflows, replace `npm test` (and `npm ci`) with your own commands. The release notes workflow
passes its inputs and the agent's answer to the shell only through environment variables; see
[Security](../docs/user-guide.md#20-security) for why.

See the [user guide](../docs/user-guide.md) for every block and option.
