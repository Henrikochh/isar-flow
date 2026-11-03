import './agent.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentEditorToHost, HostToAgentEditor, ModelCatalog } from '@isar-flow/core';
import { Spinner } from '../../components';
import { post, useHostMessages } from '../../vscode';
import { AgentHeader } from './AgentHeader';
import { fieldIssues, readAgentForm, type UpdateAgent } from './agentForm';
import { DocumentBanners } from './DocumentBanners';
import { InstructionsSection } from './InstructionsSection';
import { ModelSection } from './ModelSection';
import { PermissionsSection } from './PermissionsSection';
import { ToolsSection } from './ToolsSection';
import { TryItPanel } from './TryItPanel';
import { UsedBySection } from './UsedBySection';
import { useAgentDocument } from './useAgentDocument';
import { useTryIt } from './useTryIt';

const send = (message: AgentEditorToHost) => post(message);

const LOADING_CATALOG: ModelCatalog = { models: [], providers: [], loading: true };

export function AgentApp() {
  const { doc, receive, applyLocally, revert } = useAgentDocument();
  const [catalog, setCatalog] = useState<ModelCatalog>(LOADING_CATALOG);
  const [updateError, setUpdateError] = useState<string>();
  const tryIt = useTryIt();

  useHostMessages<HostToAgentEditor>((message) => {
    switch (message.type) {
      case 'document':
        receive(message.doc);
        break;
      case 'catalog':
        setCatalog(message.catalog);
        break;
      case 'tryItEvent':
        tryIt.handleEvent(message.event);
        break;
      case 'updateFailed':
        setUpdateError(message.error);
        revert();
        break;
    }
  });

  useEffect(() => {
    send({ type: 'ready' });
  }, []);

  const update = useCallback<UpdateAgent>(
    (set, unset) => {
      setUpdateError(undefined);
      send(unset?.length ? { type: 'update', set, unset } : { type: 'update', set });
      applyLocally(set, unset);
    },
    [applyLocally],
  );
  const openYaml = useCallback(() => send({ type: 'openYaml' }), []);
  const refreshModels = useCallback(() => send({ type: 'refreshModels' }), []);
  const addProvider = useCallback(() => send({ type: 'addProvider' }), []);
  const openWorkflow = useCallback((path: string) => send({ type: 'openWorkflow', path }), []);
  const testModel = useCallback((ref: string) => send({ type: 'testModel', ref }), []);

  const form = useMemo(() => readAgentForm(doc?.agent ?? null), [doc]);
  const issues = useMemo(() => fieldIssues(doc?.diagnostics ?? []), [doc]);
  const capabilities = useMemo(
    () => ({ tools: form.tools, permissions: { edits: form.edits, commands: form.commands } }),
    [form],
  );

  if (!doc) {
    return (
      <div className="ag-loading">
        <Spinner label="Loading agent" />
        <span>Loading agent…</span>
      </div>
    );
  }

  const agentName = form.name || doc.id;
  const readable = doc.agent !== null;
  const modelName = catalog.models.find((m) => m.ref === form.model)?.name ?? form.model;

  return (
    <div className="ag-app">
      <main className="ag-main">
        <div className="ag-column">
          <AgentHeader
            id={doc.id}
            scope={doc.scope}
            fileName={doc.fileName}
            name={form.name}
            description={form.description}
            issues={issues}
            editable={readable}
            capabilities={readable ? capabilities : null}
            update={update}
            onOpenYaml={openYaml}
          />
          <DocumentBanners
            doc={doc}
            updateError={updateError}
            onDismissUpdateError={() => setUpdateError(undefined)}
            onOpenYaml={openYaml}
          />
          {readable ? (
            <div className="ag-form">
              <ModelSection
                form={form}
                catalog={catalog}
                issues={issues}
                update={update}
                onRefresh={refreshModels}
                onAddProvider={addProvider}
                onTestModel={testModel}
              />
              <InstructionsSection
                value={form.systemPrompt}
                error={issues.message('systemPrompt').error}
                update={update}
              />
              <ToolsSection tools={form.tools} error={issues.message('tools').error} update={update} />
              <PermissionsSection form={form} issues={issues} update={update} />
              <UsedBySection id={doc.id} usedBy={doc.usedBy} onOpen={openWorkflow} />
            </div>
          ) : null}
        </div>
      </main>
      <TryItPanel
        tryIt={tryIt}
        agentId={doc.id}
        agentName={agentName}
        model={form.model ? { name: modelName, ref: form.model } : undefined}
        disabledReason={doc.valid ? undefined : 'Fix the problems in the agent file to try it.'}
      />
    </div>
  );
}
