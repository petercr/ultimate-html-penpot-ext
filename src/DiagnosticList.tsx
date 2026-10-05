import type { Diagnostic } from "./shared/contracts";

const VISIBLE_DIAGNOSTICS = 4;

/** The same finding is reported once per viewport; list it once. */
export function uniqueDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}\u0000${diagnostic.source ?? ""}\u0000${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function Entry({ diagnostic }: { diagnostic: Diagnostic }) {
  return <>{diagnostic.message} {diagnostic.source ? `(${diagnostic.source})` : ""}</>;
}

/** List items for an analysis `<ul>`: the first few inline, the rest expandable so none are hidden. */
export function DiagnosticItems({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const rest = diagnostics.slice(VISIBLE_DIAGNOSTICS);
  return <>
    {diagnostics.slice(0, VISIBLE_DIAGNOSTICS).map((diagnostic, index) => <li className="warning" key={`${diagnostic.code}-${index}`}><Entry diagnostic={diagnostic} /></li>)}
    {rest.length > 0 && <li className="warning">
      <details>
        <summary>+ {rest.length} more diagnostics</summary>
        <ul className="diagnostic-rest">
          {rest.map((diagnostic, index) => <li key={`${diagnostic.code}-${index}`}><Entry diagnostic={diagnostic} /></li>)}
        </ul>
      </details>
    </li>}
  </>;
}
