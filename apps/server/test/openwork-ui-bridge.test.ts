import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { uiBridgeRequest } from "../src/opencode-plugins/openwork-ui-bridge.js";

test("timeoutMs null leaves browser bridge requests unbounded when no abort signal is supplied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-ui-bridge-"));
  const discovery = join(directory, "openwork-ui-control.json");
  const previousDiscovery = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
  const previousFetch = globalThis.fetch;
  let observedSignal: AbortSignal | null | undefined = null;

  try {
    await writeFile(discovery, JSON.stringify({
      baseUrl: "http://127.0.0.1:43210",
      token: "test-token",
    }));
    process.env.OPENWORK_UI_CONTROL_DISCOVERY = discovery;
    globalThis.fetch = (async (_input, init) => {
      observedSignal = init?.signal;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await uiBridgeRequest("/browser/task", {
      method: "POST",
      body: { operation: "observe" },
      timeoutMs: null,
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(observedSignal, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDiscovery === undefined) delete process.env.OPENWORK_UI_CONTROL_DISCOVERY;
    else process.env.OPENWORK_UI_CONTROL_DISCOVERY = previousDiscovery;
    await rm(directory, { recursive: true, force: true });
  }
});
