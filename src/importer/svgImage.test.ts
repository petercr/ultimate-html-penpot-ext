import { describe, expect, it } from "vitest";
import { SCENE_LIMITS } from "../shared/contracts";
import { svgImageGeometry } from "./svgImage";

const VIEWPORT = { x: 10, y: 20, width: 200, height: 200 };
const source = (attributes = "", content = '<circle cx="200" cy="100" r="60"/>') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" ${attributes}>${content}</svg>`;

describe("editable SVG image geometry", () => {
  it("uses the default centered meet rule independently of the CSS object fit", () => {
    expect(svgImageGeometry(source(), VIEWPORT)).toEqual({
      viewBox: { x: 0, y: 0, width: 400, height: 200 },
      rect: { x: 10, y: 70, width: 200, height: 100 }
    });
  });

  it.each([
    ["xMinYMin", 20], ["xMidYMid", 70], ["xMaxYMax", 120]
  ])("aligns %s meet within the viewport", (alignment, y) => {
    expect(svgImageGeometry(source(`preserveAspectRatio="${alignment} meet"`), VIEWPORT)?.rect).toEqual({ x: 10, y, width: 200, height: 100 });
  });

  it.each([
    ["xMinYMin", 10], ["xMidYMid", -90], ["xMaxYMax", -190]
  ])("aligns %s slice across negative leftover space", (alignment, x) => {
    expect(svgImageGeometry(source(`preserveAspectRatio="${alignment} slice"`), VIEWPORT)?.rect).toEqual({ x, y: 20, width: 400, height: 200 });
  });

  it.each(["none", "none meet", "none slice"])("maps %s directly to the object viewport", (aspect) => {
    expect(svgImageGeometry(source(`preserveAspectRatio="${aspect}"`), VIEWPORT)?.rect).toEqual(VIEWPORT);
  });

  it("keeps a nonzero source viewBox origin for conversion size checks", () => {
    const svg = '<svg viewBox="-40, +20, 4e2, 2e2"><rect x="-40" y="20" width="400" height="200"/></svg>';
    expect(svgImageGeometry(svg, VIEWPORT)).toEqual({ viewBox: { x: -40, y: 20, width: 400, height: 200 }, rect: { x: 10, y: 70, width: 200, height: 100 } });
  });

  it("reads quoted attributes containing > and either quote style", () => {
    const svg = `<svg aria-label="a > b" data-note='width="900" height="1000"' viewBox='0 0 400 200' preserveAspectRatio='xMaxYMax'><circle r="5"/></svg>`;
    expect(svgImageGeometry(svg, VIEWPORT)?.rect).toEqual({ x: 10, y: 120, width: 200, height: 100 });
  });

  it("accepts declarations, comments, and XML entities in attribute values", () => {
    const svg = `<?xml version="1.0"?><!-- <svg viewBox="0 0 1 1"/> --><svg aria-label="a &gt; b &amp; c" viewBox="0&#32;0&#x20;400&#32;200"><title><![CDATA[<svg>]]></title></svg>`;
    expect(svgImageGeometry(svg, VIEWPORT)?.rect).toEqual({ x: 10, y: 70, width: 200, height: 100 });
  });

  it("uses fixed CSS user units when the root has no viewBox", () => {
    const svg = '<svg width="160px" height="112"><circle cx="45" cy="44" r="22"/></svg>';
    expect(svgImageGeometry(svg, VIEWPORT)).toEqual({ viewBox: { x: 0, y: 0, width: 160, height: 112 }, rect: { x: 10, y: 20, width: 160, height: 112 } });
    expect(svgImageGeometry(svg, VIEWPORT, 1.5)?.rect).toEqual({ x: 10, y: 20, width: 240, height: 168 });
  });

  it("falls back for percentage geometry in a changed no-viewBox viewport", () => {
    const svg = '<svg width="160" height="112"><rect width="100%" height="100%"/></svg>';
    expect(svgImageGeometry(svg, VIEWPORT)).toBeUndefined();
    expect(svgImageGeometry(svg, { x: 0, y: 0, width: 160, height: 112 })?.rect).toEqual({ x: 0, y: 0, width: 160, height: 112 });
  });

  it("falls back for nested SVG viewports that Penpot converts as plain groups", () => {
    expect(svgImageGeometry(source("", '<svg x="10" y="20" width="100" height="50" viewBox="0 0 20 10"><rect width="20" height="10"/></svg>'), VIEWPORT)).toBeUndefined();
  });

  it("falls back for root transforms and CSS viewport sizing", () => {
    for (const attributes of ['transform="translate(10 20)"', 'style="transform:translate(10px,20px)"', 'style="fill:red;width:100px"', 'style="height:100%"']) {
      expect(svgImageGeometry(source(attributes), VIEWPORT)).toBeUndefined();
    }
    expect(svgImageGeometry(source('style="fill:red;stroke:blue"'), VIEWPORT)).toBeDefined();
  });

  it.each(["garbage", "xMidYMid stretch", "xMiddleYMid meet", "defer xMidYMid meet", "none extra", "xmidymid"])("falls back for unsupported preserveAspectRatio %s", (aspect) => {
    expect(svgImageGeometry(source(`preserveAspectRatio="${aspect}"`), VIEWPORT)).toBeUndefined();
  });

  it.each(["0 0 0 200", "0 0 400 -1", "0 0 Infinity 200", "0 0 1e-300 200", "0 0 400", "0,,0 400 200", "0 0 400 200 extra"])("falls back for invalid viewBox %s", (viewBox) => {
    expect(svgImageGeometry(`<svg viewBox="${viewBox}"></svg>`, VIEWPORT)).toBeUndefined();
  });

  it("falls back for unbounded source dimensions and source coordinates", () => {
    for (const viewBox of [`0 0 ${SCENE_LIMITS.maxDimension + 1} 200`, `${SCENE_LIMITS.maxDimension + 1} 0 400 200`, "0 0 1e300 200"]) {
      expect(svgImageGeometry(`<svg viewBox="${viewBox}"/>`, VIEWPORT)).toBeUndefined();
    }
    expect(svgImageGeometry(source('preserveAspectRatio="xMidYMid slice"'), { x: 0, y: 0, width: 1, height: SCENE_LIMITS.maxDimension })).toBeUndefined();
  });

  it.each(["0 0 0.000001 100000", "0 0 100000 0.000001"])("falls back when %s maps to an underflowing editable frame", (viewBox) => {
    expect(svgImageGeometry(`<svg viewBox="${viewBox}"/>`, { x: 0, y: 0, width: 0.000001, height: 0.000001 })).toBeUndefined();
  });

  it("requires usable width and height if the source lacks a viewBox", () => {
    for (const attributes of ['width="160"', 'width="0" height="112"', 'width="100%" height="112"', 'width="160em" height="112"', 'width="160" height="NaN"']) {
      expect(svgImageGeometry(`<svg ${attributes}/>`, VIEWPORT)).toBeUndefined();
    }
  });

  it("rejects ambiguous root metadata and invalid attribute entities", () => {
    for (const svg of ['<svg viewBox="0 0 400 200" viewBox="0 0 10 10"/>', '<svg viewBox="0&unknown;0 400 200"/>', '<svg viewBox="0&#0;0 400 200"/>', '<svg viewBox="0 0 400 200" aria-label="&bad;"/>']) {
      expect(svgImageGeometry(svg, VIEWPORT)).toBeUndefined();
    }
  });

  it("rejects invalid viewports and transform scales", () => {
    for (const viewport of [{ ...VIEWPORT, width: 0 }, { ...VIEWPORT, height: -1 }, { ...VIEWPORT, x: Number.NaN }, { ...VIEWPORT, width: Number.POSITIVE_INFINITY }]) {
      expect(svgImageGeometry(source(), viewport)).toBeUndefined();
    }
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(svgImageGeometry(source(), VIEWPORT, scale)).toBeUndefined();
    }
  });
});
