import type { Rect, SceneBorder, SceneBorders, ScenePaint } from "../shared/contracts";

export const BORDER_SIDES = ["top", "right", "bottom", "left"] as const;
export type BorderSide = typeof BORDER_SIDES[number];

/** Older scenes carry one border; newer asymmetric scenes carry all four. */
export function borderSides(paint: ScenePaint): SceneBorders {
  if (paint.borders) return paint.borders;
  const border = { color: paint.borderColor ?? "transparent", width: paint.borderWidth ?? 0, style: paint.borderStyle ?? "solid" };
  return { top: border, right: border, bottom: border, left: border };
}

export function borderWidth(paint: ScenePaint, side: BorderSide): number {
  const border = borderSides(paint)[side];
  return border.style === "none" || border.style === "hidden" ? 0 : border.width;
}

export function uniformBorder(paint: ScenePaint): SceneBorder | undefined {
  const borders = borderSides(paint);
  return BORDER_SIDES.every((side) => borders[side].color === borders.top.color
    && borders[side].width === borders.top.width && borders[side].style === borders.top.style)
    ? borders.top : undefined;
}

export function hasBorder(paint: ScenePaint): boolean {
  return BORDER_SIDES.some((side) => borderWidth(paint, side) > 0);
}

export function borderInsets(paint: ScenePaint, width: number, height: number): [number, number, number, number] {
  let [top, right, bottom, left] = BORDER_SIDES.map((side) => borderWidth(paint, side));
  const horizontalScale = Math.min(1, width / (left + right || 1));
  const verticalScale = Math.min(1, height / (top + bottom || 1));
  left *= horizontalScale;
  right *= horizontalScale;
  top *= verticalScale;
  bottom *= verticalScale;
  return [top, right, bottom, left];
}

interface BorderPolygon {
  side: BorderSide;
  border: SceneBorder;
  /** Bounds relative to the element's unrotated top-left corner. */
  rect: Rect;
  /** Closed polygon in its own bounds, ready for an editable Penpot path. */
  d: string;
}

/** Solid, square CSS borders partition the border box at diagonal corner joins. */
export function borderPolygons(paint: ScenePaint, width: number, height: number): BorderPolygon[] {
  if (!paint.borders || uniformBorder(paint) || paint.radius?.some((radius) => radius > 0)) return [];
  const borders = borderSides(paint);
  // Valid browser boxes contain their borders. Bound externally supplied
  // scenes too, so opposing widths cannot make the inner box cross itself.
  const [top, right, bottom, left] = borderInsets(paint, width, height);
  const points: Record<BorderSide, [number, number][]> = {
    top: [[0, 0], [width, 0], [width - right, top], [left, top]],
    right: [[width, 0], [width, height], [width - right, height - bottom], [width - right, top]],
    bottom: [[width, height], [0, height], [left, height - bottom], [width - right, height - bottom]],
    left: [[0, height], [0, 0], [left, top], [left, height - bottom]]
  };
  return BORDER_SIDES.flatMap((side) => {
    const border = borders[side];
    if (!borderWidth(paint, side) || border.style !== "solid") return [];
    const vertices = points[side];
    const x = Math.min(...vertices.map(([value]) => value));
    const y = Math.min(...vertices.map(([, value]) => value));
    const rect = { x, y, width: Math.max(...vertices.map(([value]) => value)) - x, height: Math.max(...vertices.map(([, value]) => value)) - y };
    if (!rect.width || !rect.height) return [];
    const d = vertices.map(([px, py], index) => `${index ? "L" : "M"} ${px - x} ${py - y}`).join(" ") + " Z";
    return [{ side, border, rect, d }];
  });
}
