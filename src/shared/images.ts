import type { Rect, SceneNode } from "./contracts";

export interface ImageGeometry {
  /** CSS content box, relative to the image element's unrotated corner. */
  content: Rect;
  /** Fitted image bounds, in the same coordinates as the content box. */
  object: Rect;
}

/** Resolve captured object-fit/position after capture has scaled the box,
 * border widths, padding, and position offsets with its CSS transform. */
export function imageGeometry(node: SceneNode): ImageGeometry | undefined {
  const image = node.image;
  if (!image) return undefined;
  const width = node.rect.width;
  const height = node.rect.height;
  const padding = node.layout.padding ?? [0, 0, 0, 0];
  let [top, right, bottom, left] = (["top", "right", "bottom", "left"] as const)
    .map((side, index) => {
      const border = node.paint.borders?.[side] ?? { width: node.paint.borderWidth ?? 0, style: node.paint.borderStyle ?? "solid" };
      return (["none", "hidden"].includes(border.style) ? 0 : border.width) + padding[index];
    });
  // Real CSS boxes contain their borders and padding. Bound validated scenes
  // from other producers too, so overlarge insets cannot cross or go outside
  // the element when its content box is empty.
  const horizontalScale = Math.min(1, width / (left + right || 1));
  const verticalScale = Math.min(1, height / (top + bottom || 1));
  left *= horizontalScale;
  right *= horizontalScale;
  top *= verticalScale;
  bottom *= verticalScale;
  const content = { x: left, y: top, width: Math.max(0, width - left - right), height: Math.max(0, height - top - bottom) };
  const empty = (): ImageGeometry => ({ content, object: { x: content.x, y: content.y, width: 0, height: 0 } });
  if (!content.width || !content.height) return empty();

  let objectWidth = content.width;
  let objectHeight = content.height;
  if (image.fit !== "fill") {
    const intrinsicWidth = image.intrinsicWidth * (image.scale ?? 1);
    const intrinsicHeight = image.intrinsicHeight * (image.scale ?? 1);
    if (!(intrinsicWidth > 0) || !(intrinsicHeight > 0)) return empty();
    const contain = Math.min(content.width / intrinsicWidth, content.height / intrinsicHeight);
    const scale = image.fit === "contain" ? contain
      : image.fit === "cover" ? Math.max(content.width / intrinsicWidth, content.height / intrinsicHeight)
      : image.fit === "scale-down" ? Math.min(1, contain) : 1;
    objectWidth = intrinsicWidth * scale;
    objectHeight = intrinsicHeight * scale;
  }
  return {
    content,
    object: {
      x: content.x + (content.width - objectWidth) * image.position.x.percentage + image.position.x.offset,
      y: content.y + (content.height - objectHeight) * image.position.y.percentage + image.position.y.offset,
      width: objectWidth,
      height: objectHeight
    }
  };
}
