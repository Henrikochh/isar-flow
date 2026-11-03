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

| File                                                                                     | What it does                                                                                                                                                                                  | Agents          |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| [review-loop.workflow.yaml](review-loop.workflow.yaml)                                   | Implements a task, then runs the tests and a JSON review in a loop and fixes what they find, until the tests pass and the reviewer approves (at most 5 rounds).                               | coder, reviewer |
| [test-fix.workflow.yaml](test-fix.workflow.yaml)                                         | Runs the tests and lets the coder fix failures until they pass (at most 5 rounds).                                                                                                            | coder           |
| [worktree-fix.workflow.yaml](worktree-fix.workflow.yaml)                                 | Like Test and fix, but on a separate git worktree (`isolation: worktree`) with `npm ci` as setup command. Your files stay untouched until you keep the changes in the review card. Needs git. | coder           |
| [release-notes.workflow.yaml](release-notes.workflow.yaml)                               | Collects the commits since the last tag, lets the writer draft release notes, asks for your approval and adds them to `RELEASE_NOTES.md`. Uses bash (Git Bash on Windows).                    | writer          |
| [agents/coder.agent.yaml](agents/coder.agent.yaml)                                       | Implements tasks and fixes failing tests. Edits files without asking (undoable), asks before running commands.                                                                                |                 |
| [agents/reviewer.agent.yaml](agents/reviewer.agent.yaml)                                 | Read-only reviewer that answers `{"approved": …, "issues": [...]}`.                                                                                                                           |                 |
| [agents/writer.agent.yaml](agents/writer.agent.yaml)                                     | Read-only technical writer for release notes and summaries.                                                                                                                                   |                 |
| [.isarflow/simulations/review-loop.sim.yaml](.isarflow/simulations/review-loop.sim.yaml) | Mocks for simulating the review loop: the tests fail and the reviewer asks for changes in round 1; round 2 passes and is approved. Nothing runs and no model is called.                       |                 |

In the review and test workflows, replace `npm test` (and `npm ci`) with your own commands. The release notes workflow
passes its inputs and the agent's answer to the shell only through environment variables; see
[Security](../docs/user-guide.md#16-security) for why.

See the [user guide](../docs/user-guide.md) for every block and option.
