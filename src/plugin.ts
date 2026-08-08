import { importScenes, ImportCancelledError } from "./importer/penpot";
import { PROTOCOL_VERSION, type PluginToUiMessage, type UiToPluginMessage } from "./shared/contracts";
import { validateScenes } from "./shared/validation";

let cancelled = false;

function send(message: PluginToUiMessage) {
  penpot.ui.sendMessage(message);
}

penpot.ui.open("Ultimate HTML to Penpot", `?theme=${penpot.theme}`, { width: 620, height: 760 });

penpot.ui.onMessage<UiToPluginMessage>(async (message) => {
  if (!message || message.protocolVersion !== PROTOCOL_VERSION) return;
  if (message.type === "CANCEL") {
    cancelled = true;
    return;
  }
  if (message.type !== "IMPORT") return;
  cancelled = false;
  try {
    const scenes = validateScenes(message.scenes);
    const boards = await importScenes(scenes, {
      isCancelled: () => cancelled,
      onProgress: (completed, total, label) => send({ type: "PROGRESS", completed, total, label })
    });
    send({ type: "COMPLETE", boards: boards.length });
  } catch (error) {
    send({ type: "ERROR", message: error instanceof ImportCancelledError ? "Import cancelled; partial boards were removed." : error instanceof Error ? error.message : "Import failed." });
  }
});
