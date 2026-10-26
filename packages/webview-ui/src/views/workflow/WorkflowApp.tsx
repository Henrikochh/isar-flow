/** Workflow editor webview: top bar, palette, river canvas and inspector. */
import './workflow.css';
import './canvas/canvas.css';
import { useEffect } from 'react';
import { post } from '../../vscode';
import { CanvasBanners } from './banners/CanvasBanners';
import { Canvas } from './canvas/Canvas';
import { EditorDnd } from './canvas/dnd';
import { EditorProvider } from './editorContext';
import { Inspector } from './inspector/Inspector';
import { Palette } from './palette/Palette';
import { WorkflowStoreProvider } from './store';
import { TopBar } from './topbar/TopBar';

function WorkflowShell() {
  return (
    <EditorProvider>
      <EditorDnd>
        <div className="wf-app">
          <TopBar />
          <Palette />
          <main className="wf-main">
            <CanvasBanners />
            <Canvas />
          </main>
          <div className="wf-app__inspector" data-wf-inspector="">
            <Inspector />
          </div>
        </div>
      </EditorDnd>
    </EditorProvider>
  );
}

export function WorkflowApp() {
  // Effects run children first, so the store below has subscribed to host messages before 'ready' goes out.
  useEffect(() => {
    post({ type: 'ready' });
  }, []);
  return (
    <WorkflowStoreProvider>
      <WorkflowShell />
    </WorkflowStoreProvider>
  );
}
