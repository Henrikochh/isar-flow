import { Stone } from '../../components';

/** A short stretch of the river with stones on it — the canvas in miniature, used by empty states. */
export function RiverArt({ variant }: { variant: 'agents' | 'workflows' | 'folder' }) {
  return (
    <div className="sb-art" aria-hidden="true">
      <span className="sb-art__river" />
      {variant === 'workflows' ? (
        <>
          <span className="sb-art__slot">
            <Stone type="agent" size="s" />
          </span>
          <span className="sb-art__slot">
            <Stone type="console" size="s" />
          </span>
          <span className="sb-art__slot">
            <Stone type="loop" size="s" />
          </span>
        </>
      ) : variant === 'agents' ? (
        <span className="sb-art__slot">
          <Stone type="agent" size="l" />
        </span>
      ) : (
        <span className="sb-art__slot">
          <span className="if-stone if-stone--l" data-type="console">
            <i className="codicon codicon-folder-opened" />
          </span>
        </span>
      )}
    </div>
  );
}
