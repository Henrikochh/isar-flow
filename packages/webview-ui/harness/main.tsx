/**
 * Browser harness: renders a webview with a mock host, a VS Code theme and a scenario.
 * URL: /harness/index.html?view=workflow&scenario=running&theme=dark[&bare=1]
 */
import { applyTheme, type HarnessTheme } from './themes';
import { agentHost, sidebarHost, sidebarViewState, workflowHost } from './mockHost';
import { TRANSCRIPT_FIXTURE } from './transcript';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'workflow';
const scenario = params.get('scenario') ?? 'default';
const theme = (params.get('theme') ?? 'dark') as HarnessTheme;

document.body.dataset.view = view;
applyTheme(theme);

const toWebview = (message: unknown) => window.postMessage(message, '*');
const handler: (message: never) => void =
  view === 'sidebar'
    ? sidebarHost(scenario, toWebview)
    : view === 'agent'
      ? agentHost(scenario, toWebview)
      : workflowHost(scenario, toWebview);

let viewState: unknown =
  view === 'agent' && scenario === 'tryit'
    ? { tryIt: { messages: TRANSCRIPT_FIXTURE } }
    : view === 'sidebar'
      ? sidebarViewState(scenario)
      : undefined;

window.acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => {
    console.debug('[webview → host]', message);
    setTimeout(() => handler(message as never), 0);
  },
  getState: () => viewState,
  setState: (state: unknown) => {
    viewState = state;
  },
});

if (params.get('bare') !== '1') {
  const bar = document.createElement('div');
  bar.className = 'harness-bar';
  const link = (label: string, next: Record<string, string>) => {
    const p = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(next)) p.set(k, v);
    return `<a href="?${p.toString()}">${label}</a>`;
  };
  bar.innerHTML = [
    ['sidebar', 'workflow', 'agent'].map((v) => link(v, { view: v, scenario: 'default' })).join(' '),
    ['dark', 'light', 'hc', 'hcl'].map((t) => link(t, { theme: t })).join(' '),
    `<span>${view} / ${scenario}</span>`,
  ].join(' <b>|</b> ');
  document.body.appendChild(bar);
  const style = document.createElement('style');
  style.textContent =
    '.harness-bar{position:fixed;bottom:6px;left:50%;transform:translateX(-50%);z-index:9999;background:#000c;color:#fff;font:11px system-ui;padding:4px 10px;border-radius:6px;display:flex;gap:6px}.harness-bar a{color:#7fd}';
  document.head.appendChild(style);
}

await import('../src/main');
