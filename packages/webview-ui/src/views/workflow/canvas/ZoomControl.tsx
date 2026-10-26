import { IconButton } from '../../../components';
import { MAX_ZOOM, MIN_ZOOM } from './useZoom';

export function ZoomControl({
  zoom,
  onZoom,
  onFit,
}: {
  zoom: number;
  onZoom: (value: number) => void;
  onFit: () => void;
}) {
  return (
    <div className="wf-zoom" role="toolbar" aria-label="Zoom">
      <IconButton
        icon="zoom-out"
        label="Zoom out"
        disabled={zoom <= MIN_ZOOM}
        onClick={() => onZoom(zoom - 0.1)}
      />
      <button type="button" className="wf-zoom__value" title="Reset zoom to 100%" onClick={() => onZoom(1)}>
        {Math.round(zoom * 100)}%
      </button>
      <IconButton
        icon="zoom-in"
        label="Zoom in"
        disabled={zoom >= MAX_ZOOM}
        onClick={() => onZoom(zoom + 0.1)}
      />
      <span className="wf-zoom__divider" aria-hidden="true" />
      <IconButton icon="screen-full" label="Fit to window" onClick={onFit} />
    </div>
  );
}
