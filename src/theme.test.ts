import { describe, expect, it } from "vitest";
import { themeFromLocation, themeFromSearch } from "./theme";

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

describe("themeFromLocation", () => {
  it("reads the theme from Penpot's hash-style plugin URL", () => {
    expect(themeFromLocation("", "#/?theme=dark")).toBe("dark");
    expect(themeFromLocation("", "#/?theme=light")).toBe("light");
  });

  it("still honors a plain search parameter", () => {
    expect(themeFromLocation("?theme=dark", "")).toBe("dark");
  });

  it("defaults to light when neither location carries a theme", () => {
    expect(themeFromLocation("", "#/")).toBe("light");
    expect(themeFromLocation("", "")).toBe("light");
  });
});
