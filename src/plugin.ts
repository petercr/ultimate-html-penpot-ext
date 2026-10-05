import { importScenes, ImportCancelledError } from "./importer/penpot";
import { PROTOCOL_VERSION, type PluginToUiMessage, type UiToPluginMessage } from "./shared/contracts";
import { validateScenes } from "./shared/validation";

let activeRunId: string | undefined;
let cancelledRunId: string | undefined;

function send(message: PluginToUiMessage) {
  penpot.ui.sendMessage(message);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Import failed in Penpot. Check the plugin console for the failing layer.";
}

penpot.ui.open("Ultimate HTML to Penpot", `?theme=${penpot.theme}`, { width: 620, height: 760 });

penpot.ui.onMessage<UiToPluginMessage>(async (message) => {
  if (!message || message.protocolVersion !== PROTOCOL_VERSION) return;
  if (message.type === "CANCEL") {
    if (message.runId === activeRunId) cancelledRunId = message.runId;
    return;
  }
  if (message.type !== "IMPORT") return;
  if (activeRunId) {
    send({ type: "ERROR", runId: message.runId, message: "Another import is already running. Cancel it or wait for it to finish." });
    return;
  }
  activeRunId = message.runId;
  cancelledRunId = undefined;
  try {
    const scenes = validateScenes(message.scenes);
    const boards = await importScenes(scenes, {
      isCancelled: () => cancelledRunId === message.runId,
      onProgress: (completed, total, label) => send({ type: "PROGRESS", runId: message.runId, completed, total, label }),
      onDiagnostic: (diagnostic) => send({ type: "DIAGNOSTIC", runId: message.runId, diagnostic }),
      nativeLayout: message.nativeLayout === true
    });
    if (activeRunId === message.runId) send({ type: "COMPLETE", runId: message.runId, boards: boards.length });
  } catch (error) {
    if (activeRunId === message.runId) send({ type: "ERROR", runId: message.runId, message: error instanceof ImportCancelledError ? "Import cancelled; partial boards were removed." : errorMessage(error) });
  } finally {
    if (activeRunId === message.runId) activeRunId = undefined;
  }
});
