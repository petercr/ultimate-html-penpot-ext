import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SceneDocument, SceneNode } from "../shared/contracts";
import { planFlex } from "./flexLayout";

interface Evidence { fixtures: { file: string; viewports: { scene: SceneDocument }[] }[] }
const evidence = JSON.parse(readFileSync(resolve("src/capture/fixtures/baselines/scene-evidence.json"), "utf8")) as Evidence;
const scenes = evidence.fixtures.find((fixture) => fixture.file === "flex-layouts.html")!.viewports.map((viewport) => viewport.scene);

function decide(scene: SceneDocument, source: string) {
  const container = scene.nodes.find((node) => node.source === source)!;
  const domOrder = new Map(scene.nodes.map((node, index) => [node.id, index]));
  const children = scene.nodes.filter((node) => node.parentId === container.id).sort((a: SceneNode, b: SceneNode) => domOrder.get(a.id)! - domOrder.get(b.id)!);
  return planFlex(container, children);
}

describe("flex fixture decisions", () => {
  const supported = ["#basic", "#between", "#column", "#centered", "#card", "#with-badge"];
  const kept: [string, RegExp][] = [
    ["#card-text", /do not match/], ["#wrapping", /Wrapping/], ["#reversed", /row-reverse/], ["#margins", /do not match/], ["#ordered", /do not match/], ["#baseline", /baseline/]
  ];

  it.each(scenes.map((scene) => [scene.viewport.name, scene] as const))("%s converts the supported containers and keeps the rest fixed", (_name, scene) => {
    for (const source of supported) expect(decide(scene, source), source).toHaveProperty("plan");
    for (const [source, reason] of kept) expect(decide(scene, source), source).toMatchObject({ reason: expect.stringMatching(reason) });
  });

  it("reads the card's padding as CSS padding plus its 2px border, and the badge as outside the flow", () => {
    const card = decide(scenes[0], "#card");
    expect(card).toMatchObject({ plan: { dir: "row", gap: 12, padding: [14, 14, 14, 14], align: "center" } });
    const badge = decide(scenes[0], "#with-badge");
    expect("plan" in badge && badge.plan.absolute).toHaveLength(1);
    expect("plan" in badge && badge.plan.flow).toHaveLength(2);
  });
});
