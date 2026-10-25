import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SceneDocument } from "../shared/contracts";
import { planSceneFlex } from "./flexLayout";

interface Evidence { fixtures: { file: string; viewports: { scene: SceneDocument }[] }[] }
const evidence = JSON.parse(readFileSync(resolve("src/capture/fixtures/baselines/scene-evidence.json"), "utf8")) as Evidence;
const scenes = evidence.fixtures.find((fixture) => fixture.file === "flex-layouts.html")!.viewports.map((viewport) => viewport.scene);

function decide(scene: SceneDocument, source: string) {
  return planSceneFlex(scene).find(({ node }) => node.source === source)!.decision;
}

describe("flex fixture decisions", () => {
  const supported = [
    "#basic", "#between", "#column", "#centered", "#card", "#card-text", "#with-badge", "#wrapping", "#reversed",
    "#text-row", "#grow", "#grow-equal", "#grow-unequal", "#column-reverse", "#wrap-centered", "#padded-item"
  ];
  const kept: [string, RegExp][] = [["#wrap-reversed", /break their lines/], ["#wrap-reverse", /wrap-reverse/], ["#margins", /do not match/], ["#ordered", /do not match/], ["#baseline", /baseline/]];

  it.each(scenes.map((scene) => [scene.viewport.name, scene] as const))("%s converts the supported containers and keeps the rest fixed", (_name, scene) => {
    for (const source of supported) expect(decide(scene, source), source).toHaveProperty("plan");
    for (const [source, reason] of kept) expect(decide(scene, source), source).toMatchObject({ reason: expect.stringMatching(reason) });
  });

  it.each(scenes.map((scene) => [scene.viewport.name, scene] as const))("%s decides every flex container below the scene root, in source order", (_name, scene) => {
    const flex = scene.nodes.filter((node) => node.layout.kind === "flex" && node.parentId);
    expect(planSceneFlex(scene).map(({ node }) => node.source)).toEqual(flex.map((node) => node.source));
    expect(flex.length).toBeGreaterThan(20);
  });

  it("reads the card's padding as CSS padding plus its 2px border, and the badge as outside the flow", () => {
    const card = decide(scenes[0], "#card");
    expect(card).toMatchObject({ plan: { dir: "row", gap: 12, padding: [14, 14, 14, 14], align: "center" } });
    const badge = decide(scenes[0], "#with-badge");
    expect("plan" in badge && badge.plan.absolute).toHaveLength(1);
    expect("plan" in badge && badge.plan.flow).toHaveLength(2);
  });

  it.each(scenes.map((scene) => [scene.viewport.name, scene] as const))("%s lays out text items by their element box", (_name, scene) => {
    // Each line's glyphs sit a pixel below the top of its line box; the rest of the leading is below.
    for (const source of ["#card-text", "#text-row"]) {
      const decision = decide(scene, source);
      if (!("plan" in decision)) throw new Error(source);
      decision.plan.flow.forEach((child, index) => {
        if (child.kind !== "text") return expect(decision.plan.margins[index]).toEqual([0, 0, 0, 0]);
        expect(decision.plan.margins[index][0]).toBeCloseTo(1, 1);
        expect(decision.plan.margins[index][2]).toBeGreaterThan(1);
      });
    }
  });

  it.each(scenes.map((scene) => [scene.viewport.name, scene] as const))("%s fills with equal growth and keeps unequal growth at its captured size", (_name, scene) => {
    expect(decide(scene, "#grow")).toMatchObject({ plan: { fill: [false, true, false] } });
    expect(decide(scene, "#grow-equal")).toMatchObject({ plan: { fill: [false, true, true] } });
    expect(decide(scene, "#grow-unequal")).toMatchObject({ plan: { fill: [false, false] } });
  });

  it("reads wrapping and reversed containers with their line gaps and line placement", () => {
    expect(decide(scenes[0], "#wrapping")).toMatchObject({ plan: { dir: "row", wrap: true, gap: 6, crossGap: 6, alignContent: "stretch" } });
    expect(decide(scenes[0], "#wrap-centered")).toMatchObject({ plan: { wrap: true, gap: 6, crossGap: 4, justify: "center", alignContent: "center", align: "center" } });
    expect(decide(scenes[0], "#column-reverse")).toMatchObject({ plan: { dir: "column-reverse", wrap: false, align: "end" } });
  });
});
