import { Section } from '../../components';

export function UsedBySection({ id, usedBy }: { id: string; usedBy: string[] }) {
  const reference = `agent: ${id}`;
  return (
    <Section
      title="Used by"
      actions={usedBy.length ? <span className="ag-section-count">{usedBy.length === 1 ? '1 workflow' : `${usedBy.length} workflows`}</span> : null}
    >
      {usedBy.length ? (
        <ul className="ag-used-by">
          {usedBy.map((path) => (
            <li key={path} className="ag-used-by__item">
              <span className="ag-used-by__tile" aria-hidden="true">
                <i className="codicon codicon-pulse ag-used-by__icon" />
              </span>
              <span className="ag-used-by__path" title={path}>
                {path}
              </span>
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
