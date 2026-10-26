import '@vscode/codicons/dist/codicon.css';
import '@fontsource/barlow-semi-condensed/500.css';
import '@fontsource/barlow-semi-condensed/600.css';
import '@fontsource/barlow-semi-condensed/700.css';
import './theme/tokens.css';
import './theme/base.css';
import './components';
import { createRoot } from 'react-dom/client';
import { currentView } from './vscode';
import { SidebarApp } from './views/sidebar/SidebarApp';
import { WorkflowApp } from './views/workflow/WorkflowApp';
import { AgentApp } from './views/agent/AgentApp';

const view = currentView();
const App = view === 'workflow' ? WorkflowApp : view === 'agent' ? AgentApp : SidebarApp;

createRoot(document.getElementById('root')!).render(<App />);
