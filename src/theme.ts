export type PluginTheme = "light" | "dark";

export function themeFromSearch(search: string): PluginTheme {
  return new URLSearchParams(search).get("theme") === "dark" ? "dark" : "light";
}
