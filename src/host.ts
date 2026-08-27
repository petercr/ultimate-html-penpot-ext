/**
 * Standalone detection for the plugin UI.
 *
 * Penpot always opens the plugin UI inside an iframe, so a window without a
 * parent frame has no plugin runtime to receive IMPORT/CANCEL postMessages
 * and an import could never complete. Analysis must not depend on this: the
 * capture sandbox is created by the UI itself and answers on `window`.
 */

export interface HostFrameLike {
  readonly parent: unknown;
}

export function isStandaloneHost(frame: HostFrameLike = window): boolean {
  return frame.parent === frame;
}
