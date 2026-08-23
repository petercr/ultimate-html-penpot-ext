export type PluginTheme = "light" | "dark";

export function themeFromSearch(search: string): PluginTheme {
  return new URLSearchParams(search).get("theme") === "dark" ? "dark" : "light";
}

export function themeFromLocation(search: string, hash: string): PluginTheme {
  const hashQuery = hash.includes("?") ? hash.slice(hash.indexOf("?")) : "";
  return themeFromSearch(search) === "dark" || themeFromSearch(hashQuery) === "dark" ? "dark" : "light";
}
