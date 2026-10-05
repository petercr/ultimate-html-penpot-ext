import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiagnosticItems, uniqueDiagnostics } from "./DiagnosticList";
import type { Diagnostic } from "./shared/contracts";

const diagnostic = (code: string, source: string, viewportId = "desktop"): Diagnostic => ({ severity: "warning", code, message: `${code} message.`, source, viewportId });

describe("diagnostic list", () => {
  it("lists a finding once even when every viewport reports it", () => {
    const repeated = ["desktop", "tablet", "mobile"].map((viewportId) => diagnostic("UNSUPPORTED_OUTLINE", "#ring", viewportId));
    expect(uniqueDiagnostics([...repeated, diagnostic("UNSUPPORTED_OUTLINE", "#other")])).toHaveLength(2);
  });

  it("shows four inline and keeps the rest reachable instead of only counting them", () => {
    const many = Array.from({ length: 7 }, (_, index) => diagnostic(`CODE_${index}`, `#item-${index}`));
    const markup = renderToStaticMarkup(<ul><DiagnosticItems diagnostics={many} /></ul>);
    expect(markup).toContain("CODE_3 message.");
    expect(markup).toContain("+ 3 more diagnostics");
    // Hidden entries are in the expandable section, not dropped.
    expect(markup).toContain("CODE_6 message. (#item-6)");
    expect(markup).toContain("<details>");
  });

  it("omits the expander when everything fits", () => {
    const markup = renderToStaticMarkup(<ul><DiagnosticItems diagnostics={[diagnostic("ONLY", "#one")]} /></ul>);
    expect(markup).toContain("ONLY message. (#one)");
    expect(markup).not.toContain("<details>");
  });
});
