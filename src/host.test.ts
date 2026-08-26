import { describe, expect, it } from "vitest";
import { isStandaloneHost } from "./host";

describe("isStandaloneHost", () => {
  it("treats a window without a parent frame as standalone", () => {
    const frame: { parent: unknown } = { parent: null };
    frame.parent = frame;

    expect(isStandaloneHost(frame)).toBe(true);
  });

  it("treats an embedded frame as hosted when the parent differs", () => {
    const hostWindow = {} as unknown;
    expect(isStandaloneHost({ parent: hostWindow })).toBe(false);
  });
});
