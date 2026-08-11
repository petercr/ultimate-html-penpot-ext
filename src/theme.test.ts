import { describe, expect, it } from "vitest";
import { themeFromSearch } from "./theme";

describe("themeFromSearch", () => {
  it("uses Penpot's dark theme when requested", () => {
    expect(themeFromSearch("?theme=dark")).toBe("dark");
  });

  it("defaults unknown and missing themes to light", () => {
    expect(themeFromSearch("?theme=light")).toBe("light");
    expect(themeFromSearch("?theme=unexpected")).toBe("light");
    expect(themeFromSearch("")).toBe("light");
  });
});
