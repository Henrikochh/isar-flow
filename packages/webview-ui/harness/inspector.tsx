/**
 * Inspector-only harness: the workflow editor's right column next to a strip of canvas, driven by the mock host.
 * URL: /harness/inspector.html?scenario=running&theme=dark[&select=review][&click=<selector>|text:<label>]…
 * `select` focuses a block after the scenario is ready ('' clears the selection); each `click` is applied in order.
 * Sets body[data-inspector-ready] when done (used by scripts/inspector-shots.mjs).
 */
import '@vscode/codicons/dist/codicon.css';
import '@fontsource/barlow-semi-condensed/500.css';
import '@fontsource/barlow-semi-condensed/600.css';
import '@fontsource/barlow-semi-condensed/700.css';
import '../src/theme/tokens.css';
import '../src/theme/base.css';
import '../src/components';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme, type HarnessTheme } from './themes';
import { workflowHost } from './mockHost';
import { post } from '../src/vscode';
import { WorkflowStoreProvider } from '../src/views/workflow/store';
import { Inspector } from '../src/views/workflow/inspector/Inspector';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'default';
const theme = (params.get('theme') ?? 'dark') as HarnessTheme;
const select = params.get('select');
const clicks = params.getAll('click');

document.body.dataset.view = 'workflow';
applyTheme(theme);

const toWebview = (message: unknown) => window.postMessage(message, '*');
const handler = workflowHost(scenario, toWebview) as (message: never) => void;
let viewState: unknown;
window.acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => setTimeout(() => handler(message as never), 0),
  getState: () => viewState,
  setState: (state: unknown) => {
    viewState = state;
  },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function whenHarnessReady(): Promise<void> {
  for (let i = 0; i < 100 && document.body.dataset.harnessReady !== 'true'; i++) await sleep(50);
}

function clickTarget(spec: string): HTMLElement | null {
  if (spec.startsWith('text:')) {
    const text = spec.slice(5);
    return (
      Array.from(
        document.querySelectorAll<HTMLElement>('button, [role="option"], [role="tab"], [role="radio"]'),
      ).find((el) => el.textContent?.trim() === text) ?? null
    );
  }
  return document.querySelector<HTMLElement>(spec);
}

async function script(): Promise<void> {
  await whenHarnessReady();
  if (select !== null) {
    window.postMessage({ type: 'focusStep', stepId: select }, '*');
    await sleep(120);
  }
  for (const spec of clicks) {
    const target = clickTarget(spec);
    if (!target) console.error(`[inspector harness] nothing to click for ${spec}`);
    target?.click();
    await sleep(160);
  }
  document.body.dataset.inspectorReady = 'true';
}

function Shell() {
  useEffect(() => {
    post({ type: 'ready' });
    void script();
  }, []);
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1, background: 'var(--if-bg)' }} />
      <div style={{ width: 360, flex: 'none', borderLeft: '1px solid var(--if-border)' }}>
        <Inspector />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <WorkflowStoreProvider>
    <Shell />
  </WorkflowStoreProvider>,
);
