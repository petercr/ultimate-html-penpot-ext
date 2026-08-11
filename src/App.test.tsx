import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App source fields", () => {
  it("puts the HTML-or-URL source before the optional Base URL", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup.indexOf('id="html-source"')).toBeGreaterThan(-1);
    expect(markup.indexOf('id="html-source"')).toBeLessThan(markup.indexOf('id="base-url"'));
    expect(markup).toContain("HTML or page URL");
    expect(markup).toContain("https://example.com/page");
  });
});
