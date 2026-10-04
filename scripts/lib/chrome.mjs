/** Minimal NUL-delimited CDP peer for Chrome's --remote-debugging-pipe. */
export class CdpPipe {
  #input;
  #output;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #buffer = Buffer.alloc(0);
  #failure;
  #timeoutMs;

  constructor(input, output, chrome, timeoutMs = 15_000) {
    this.#timeoutMs = timeoutMs;
    this.#input = input;
    this.#output = output;
    output.on("data", (chunk) => this.#receive(chunk));
    const fail = (source, error) => this.#failAll(new Error(`CDP ${source}: ${error instanceof Error ? error.message : error}`));
    input.on("error", (error) => fail("stdin error", error));
    input.on("close", () => fail("stdin closed", "Chrome closed the debugging pipe"));
    output.on("error", (error) => fail("stdout error", error));
    output.on("end", () => fail("stdout ended", "Chrome closed the debugging pipe"));
    output.on("close", () => fail("stdout closed", "Chrome closed the debugging pipe"));
    chrome.on("error", (error) => fail("Chrome process error", error));
    chrome.on("exit", (code, signal) => fail("Chrome process exited", `code ${code ?? "null"}, signal ${signal ?? "none"}`));
    chrome.on("close", (code, signal) => fail("Chrome process closed", `code ${code ?? "null"}, signal ${signal ?? "none"}`));
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) || [];
    listeners.push(listener);
    this.#listeners.set(method, listeners);
  }

  send(method, params = {}, sessionId) {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    const frame = Buffer.from(`${JSON.stringify(message)}\0`);
    return new Promise((resolveMessage, rejectMessage) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        rejectMessage(new Error(`${method} timed out after ${this.#timeoutMs}ms.`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve: resolveMessage, reject: rejectMessage, timeout });
      try {
        this.#input.write(frame, (error) => {
          if (!error) return;
          const pending = this.#pending.get(id);
          this.#pending.delete(id);
          if (pending) clearTimeout(pending.timeout);
          rejectMessage(error);
        });
      } catch (error) {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        if (pending) clearTimeout(pending.timeout);
        rejectMessage(error);
      }
    }).then((messageResult) => {
      if (messageResult.error) throw new Error(`${method}: ${messageResult.error.message || JSON.stringify(messageResult.error)}`);
      return messageResult.result;
    });
  }

  #receive(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.includes(0)) {
      const end = this.#buffer.indexOf(0);
      let message;
      try {
        message = JSON.parse(this.#buffer.subarray(0, end).toString("utf8"));
      } catch (error) {
        this.#failAll(new Error(`Invalid CDP message: ${error instanceof Error ? error.message : error}`));
        return;
      }
      this.#buffer = this.#buffer.subarray(end + 1);
      if (message.id) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (pending) clearTimeout(pending.timeout);
        pending?.resolve(message);
      } else {
        for (const listener of this.#listeners.get(message.method) || []) listener(message);
      }
    }
  }

  #failAll(error) {
    if (this.#failure) return;
    this.#failure = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.#failure);
    }
    this.#pending.clear();
  }
}

export async function closeChrome(chrome) {
  if (chrome.exitCode !== null) return;
  await new Promise((resolveExit) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.removeListener("exit", finish);
      chrome.removeListener("close", finish);
      resolveExit(undefined);
    };
    const timeout = setTimeout(() => {
      try { chrome.kill("SIGKILL"); } catch { /* Cleanup is best effort after a bounded wait. */ }
      finish();
    }, 5_000);
    chrome.once("exit", finish);
    chrome.once("close", finish);
    try { chrome.kill("SIGTERM"); } catch { finish(); }
  });
}
