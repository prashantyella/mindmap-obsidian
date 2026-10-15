export const HEATMAP_HEIGHT = 180;

export interface HeatmapGeometry {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  plotWidth: number;
  plotHeight: number;
  xFor(index: number): number;
  yFor(level: number): number;
  hitBounds(index: number): { x: number; width: number };
}

/** Geometry is expressed in the same CSS pixels used to display the SVG. */
export function createHeatmapGeometry(measuredWidth: number, candidateCount: number): HeatmapGeometry {
  const width = Math.max(1, Number.isFinite(measuredWidth) ? measuredWidth : 1);
  const count = Math.max(0, candidateCount);
  const horizontalInset = Math.min(10, width / 4);
  const left = horizontalInset;
  const right = horizontalInset;
  const top = 14;
  const bottom = 22;
  const plotWidth = Math.max(0, width - left - right);
  const plotHeight = HEATMAP_HEIGHT - top - bottom;
  const xFor = (index: number): number => left + (count <= 1 ? plotWidth / 2 : (plotWidth * index) / (count - 1));
  const hitBounds = (index: number): { x: number; width: number } => {
    if (count <= 1) return { x: left, width: plotWidth };
    const x = xFor(index);
    const previous = index === 0 ? left : (xFor(index - 1) + x) / 2;
    const next = index === count - 1 ? width - right : (x + xFor(index + 1)) / 2;
    return { x: previous, width: Math.max(0, next - previous) };
  };

  return {
    width,
    height: HEATMAP_HEIGHT,
    left,
    right,
    top,
    bottom,
    plotWidth,
    plotHeight,
    xFor,
    yFor: (level: number) => top + plotHeight - (plotHeight * level) / 4,
    hitBounds,
  };
}

export function clampHeatmapTooltip(
  pointer: { x: number; y: number },
  container: { width: number; height: number },
  tooltip: { width: number; height: number },
): { x: number; y: number } {
  const margin = Math.min(12, Math.max(0, container.width / 2));
  const maxX = Math.max(margin, container.width - tooltip.width - margin);
  const maxY = Math.max(margin, container.height - tooltip.height - margin);
  return {
    x: Math.min(Math.max(pointer.x + 12, margin), maxX),
    y: Math.min(Math.max(pointer.y + 12, margin), maxY),
  };
}
