import { describe, expect, it } from 'vitest';
import { buildWebviewHtml, createNonce } from '../../src/webview/html';

describe('buildWebviewHtml', () => {
  const html = buildWebviewHtml({
    cspSource: 'vscode-webview://abc',
    scriptUri: 'vscode-webview://abc/media/webview/main.js',
    styleUri: 'vscode-webview://abc/media/webview/main.css',
    nonce: 'N0NCE',
    view: 'workflow',
    title: 'Review <loop>',
  });

  it('locks scripts to the nonce and the webview origin', () => {
    expect(html).toContain("script-src 'nonce-N0NCE' vscode-webview://abc");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<script type="module" nonce="N0NCE"');
  });

  it('allows no remote origins', () => {
    const csp = /content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(csp).not.toMatch(/https?:/);
  });

  it('marks the view on the body and escapes the title', () => {
    expect(html).toContain('<body data-view="workflow">');
    expect(html).toContain('<title>Review &lt;loop&gt;</title>');
  });
});

describe('createNonce', () => {
  it('creates distinct 32-char alphanumeric nonces', () => {
    const a = createNonce();
    expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(createNonce()).not.toBe(a);
  });
});
