import { Section } from '../../components';

export function UsedBySection({
  id,
  usedBy: paths,
  onOpen,
}: {
  id: string;
  usedBy: string[];
  onOpen: (path: string) => void;
}) {
  const reference = `agent: ${id}`;
  // Workspace folders can hold workflows at the same relative path; the host opens one of them per path.
  const usedBy = [...new Set(paths)];
  return (
    <Section
      title="Used by"
      actions={usedBy.length ? <span className="ag-section-count">{usedBy.length === 1 ? '1 workflow' : `${usedBy.length} workflows`}</span> : null}
    >
      {usedBy.length ? (
        <ul className="ag-used-by">
          {usedBy.map((path) => (
            <li key={path}>
              <button
                type="button"
                className="ag-used-by__item"
                aria-label={`Open workflow ${path}`}
                title={path}
                onClick={() => onOpen(path)}
              >
                <span className="ag-used-by__tile" aria-hidden="true">
                  <i className="codicon codicon-pulse ag-used-by__icon" />
                </span>
                <span className="ag-used-by__path">{path}</span>
                <i className="codicon codicon-go-to-file ag-used-by__open" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ag-used-by__empty">No workflow uses this agent yet.</p>
      )}
      <p className="ag-used-by__hint">
        <span>Workflow blocks refer to it as</span>
        <code className="ag-used-by__ref">{reference}</code>
      </p>
    </Section>
  );
}
