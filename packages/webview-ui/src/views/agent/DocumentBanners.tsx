import type { AgentDocumentState } from '@isar-flow/core';
import { Banner, Button } from '../../components';
import { leadingDiagnostic } from './agentForm';

function where(doc: AgentDocumentState, line: number | undefined): string {
  return line === undefined ? doc.fileName : `Line ${line + 1} of ${doc.fileName}`;
}

/** Invalid-file and failed-update banners shown between the header and the form. */
export function DocumentBanners({
  doc,
  updateError,
  onDismissUpdateError,
  onOpenYaml,
}: {
  doc: AgentDocumentState;
  updateError?: string;
  onDismissUpdateError: () => void;
  onOpenYaml: () => void;
}) {
  const first = doc.valid ? undefined : leadingDiagnostic(doc.diagnostics);
  const more = doc.diagnostics.filter((d) => d.severity === 'error').length - 1;
  const showInvalid = !doc.valid;
  if (!showInvalid && !updateError) return null;

  return (
    <div className="ag-banners">
      {updateError ? (
        <Banner
          tone="error"
          title="The change couldn't be saved"
          actions={
            <>
              <Button size="s" variant="secondary" icon="go-to-file" onClick={onOpenYaml}>
                Open YAML
              </Button>
              <Button size="s" variant="ghost" onClick={onDismissUpdateError}>
                Dismiss
              </Button>
            </>
          }
        >
          {updateError}
        </Banner>
      ) : null}
      {showInvalid ? (
        <Banner
          tone="error"
          title={first?.message ?? 'This agent file has problems.'}
          actions={
            <Button size="s" variant="secondary" icon="go-to-file" onClick={onOpenYaml}>
              Open YAML
            </Button>
          }
        >
          <span className="ag-banner-detail">
            <span>{where(doc, first?.range?.start.line)}</span>
            {doc.agent === null ? (
              <span>Fix the YAML to edit the agent here.</span>
            ) : more > 0 ? (
              <span>{more === 1 ? 'One more problem is marked below.' : `${more} more problems are marked below.`}</span>
            ) : null}
          </span>
        </Banner>
      ) : null}
    </div>
  );
}
