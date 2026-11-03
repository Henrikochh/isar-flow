/**
 * Browser stand-in for the extension host. It speaks the real protocol and uses the real core
 * (YAML ops, validation, engine) so the harness behaves like VS Code minus the file system and models.
 */
export { probe, markReady } from './mockShared';
export { workflowHost, type WorkflowHostOptions } from './workflowHost';
export { sidebarHost, sidebarViewState } from './sidebarHost';
export { agentHost } from './agentHost';
