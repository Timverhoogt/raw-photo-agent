import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { BridgeError, FileBridge } from "../src/bridge.ts";

type Request = { protocolVersion: number; id: string; operation: string; params: Record<string, unknown>; issuedAt: number; deadlineAt: number };
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
// Response/protocol tests must not race CPU-heavy native image diagnostics.
// The dedicated timeout test below supplies its own short deadline.
const PEER_TIMEOUT_MS = 5_000;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "lightroom-bridge-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, bridge: new FileBridge(directory, { timeoutMs: PEER_TIMEOUT_MS, pollMs: 5 }) };
}

async function nextRequest(directory: string): Promise<Request> {
  const deadline = Date.now() + PEER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const names = await readdir(join(directory, "requests"));
      // Mirror Bridge.lua: completed requests stay as history and their
      // immutable response keeps the worker from executing them again.
      for (const name of names.filter(name => name.endsWith(".json"))) {
        try {
          await stat(join(directory, "responses", name));
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return JSON.parse(await readFile(join(directory, "requests", name), "utf8"));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await pause(2);
  }
  throw new Error("Fake peer never received a request.");
}

async function respond(directory: string, request: Request, response: unknown) {
  const temporary = join(directory, "responses", `${request.id}.tmp`);
  await writeFile(temporary, typeof response === "string" ? response : JSON.stringify(response), { mode: 0o600 });
  // Preserve submitted requests as native worker history.
  await rename(temporary, join(directory, "responses", `${request.id}.json`));
}

test("atomic request roundtrip validates the protocol and private permissions", async (t) => {
  const { directory, bridge } = await fixture(t);
  const peer = (async () => {
    const request = await nextRequest(directory);
    assert.equal(request.protocolVersion, 1);
    assert.match(request.id, /^[0-9a-f-]{36}$/);
    assert.equal(request.operation, "set_exposure");
    assert.deepEqual(request.params, { exposure: 0.25 });
    assert.ok(request.issuedAt <= Date.now());
    assert.equal(request.deadlineAt - request.issuedAt, PEER_TIMEOUT_MS);
    for (const path of [directory, join(directory, "requests"), join(directory, "responses")]) {
      assert.equal((await stat(path)).mode & 0o777, 0o700);
    }
    for (const path of [join(directory, "call.lock"), join(directory, "requests", `${request.id}.json`)]) {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    assert.deepEqual(await readdir(join(directory, "requests")), [`${request.id}.json`]);
    const raw = `${JSON.stringify({ protocolVersion: 1, id: request.id, ok: true, result: { exposure: 0.25 } }, null, 2)}\n`;
    await respond(directory, request, raw);
    return { request, raw };
  })();
  assert.deepEqual(await bridge.call("set_exposure", { exposure: 0.25 }), { exposure: 0.25 });
  const { request, raw } = await peer;
  assert.deepEqual(await readdir(join(directory, "responses")), [`${request.id}.json`]);
  assert.equal(await readFile(join(directory, "responses", `${request.id}.json`), "utf8"), raw);
  assert.deepEqual(await readdir(join(directory, "requests")), [`${request.id}.json`]);
  assert.ok(!(await readdir(directory)).includes("call.lock"));
});

test("remote errors retain the peer's code and message", async (t) => {
  const { directory, bridge } = await fixture(t);
  const peer = (async () => {
    const request = await nextRequest(directory);
    await respond(directory, request, { protocolVersion: 1, id: request.id, ok: false, error: { code: "NO_PHOTO", message: "Select a photo." } });
  })();
  await assert.rejects(bridge.call("selected_photo"), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "NO_PHOTO");
    assert.equal(error.message, "Select a photo.");
    assert.equal(error.outcomeUncertain, false);
    return true;
  });
  await peer;
});

test("consumed successes and remote errors remain immutable while subsequent calls proceed without retry", async (t) => {
  const { directory, bridge } = await fixture(t);
  const scenarios: Array<{ operation: string; result?: unknown; error?: { code: string; message: string; outcomeUncertain: boolean; details: unknown } }> = [
    { operation: "apply", result: { stateToken: "edited" } },
    { operation: "create_working_copy", error: { code: "TARGET_CHANGED", message: "Copy selection changed.", outcomeUncertain: true, details: { createdPhotoId: "copy-2" } } },
    { operation: "apply", error: { code: "INVALID_ADJUSTMENT", message: "Rejected before editing.", outcomeUncertain: false, details: { field: "Exposure2012" } } },
    { operation: "read_state", result: { photoId: "copy-2", stateToken: "unchanged" } },
  ];
  const evidence = new Map<string, string>();
  for (const scenario of scenarios) {
    const peer = (async () => {
      const request = await nextRequest(directory);
      assert.equal(request.operation, scenario.operation);
      assert.equal(evidence.has(request.id), false, "Never resubmit an already-consumed request");
      const response = scenario.error
        ? { protocolVersion: 1, id: request.id, ok: false, error: scenario.error }
        : { protocolVersion: 1, id: request.id, ok: true, result: scenario.result };
      const raw = `${JSON.stringify(response, null, 2)}\n`;
      evidence.set(request.id, raw);
      await respond(directory, request, raw);
      return request.id;
    })();
    const call = scenario.error
      ? assert.rejects(bridge.call(scenario.operation), (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, scenario.error!.code);
        assert.equal(error.message, scenario.error!.message);
        assert.equal(error.outcomeUncertain, scenario.error!.outcomeUncertain);
        assert.equal(error.operation, scenario.operation);
        assert.ok(evidence.has(error.requestId!));
        return true;
      })
      : bridge.call(scenario.operation).then(result => assert.deepEqual(result, scenario.result));
    await Promise.all([call, peer]);
    const expectedNames = [...evidence.keys()].map(id => `${id}.json`).sort();
    assert.deepEqual((await readdir(join(directory, "requests"))).sort(), expectedNames, "Exactly one submitted request per explicit call");
    assert.deepEqual((await readdir(join(directory, "responses"))).sort(), expectedNames);
    for (const [id, raw] of evidence) {
      assert.equal(await readFile(join(directory, "responses", `${id}.json`), "utf8"), raw, "Preserve the original payload and formatting after later calls");
    }
    assert.ok(!(await readdir(directory)).includes("call.lock"));
  }
});

test("remote uncertainty honors explicit flags and conservatively handles older peers", async (t) => {
  const cases = [
    ...["VERIFY_FAILED", "RESTORE_UNVERIFIED", "OUTCOME_UNKNOWN", "RENDER_STALE"].map(code => ({
      operation: "apply", error: { code, message: "Inspect the current photo." }, expected: true,
    })),
    ...["create_working_copy", "checkpoint", "apply", "restore", "create_subject_mask", "create_background_mask", "auto_tone", "adjust_mask"].map(operation => ({
      operation, error: { code: "INTERNAL_ERROR", message: "Unexpected exception." }, expected: true,
    })),
    { operation: "read_state", error: { code: "INTERNAL_ERROR", message: "Read failed." }, expected: false },
    { operation: "apply", error: { code: "INVALID_ADJUSTMENT", message: "Rejected before editing." }, expected: false },
    { operation: "apply", error: { code: "CUSTOM_FAILURE", message: "Partial edit.", outcomeUncertain: true }, expected: true },
    { operation: "apply", error: { code: "VERIFY_FAILED", message: "Failed a preflight check.", outcomeUncertain: false }, expected: false },
    { operation: "restore", error: { code: "INTERNAL_ERROR", message: "No write began.", outcomeUncertain: false }, expected: false },
  ];
  for (const [index, scenario] of cases.entries()) {
    await t.test(`${index}: ${scenario.operation}/${scenario.error.code}`, async (subtest) => {
      const { directory, bridge } = await fixture(subtest);
      const peer = (async () => {
        const request = await nextRequest(directory);
        await respond(directory, request, { protocolVersion: 1, id: request.id, ok: false, error: scenario.error });
      })();
      await assert.rejects(bridge.call(scenario.operation), (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, scenario.error.code);
        assert.equal(error.message, scenario.error.message);
        assert.equal(error.outcomeUncertain, scenario.expected);
        return true;
      });
      await peer;
    });
  }
});

for (const [name, makeResponse] of [
  ["invalid JSON", () => "not json"],
  ["wrong ID", () => ({ protocolVersion: 1, id: "another-request", ok: true, result: null })],
  ["wrong version", (id: string) => ({ protocolVersion: 2, id, ok: true, result: null })],
  ["nonboolean status", (id: string) => ({ protocolVersion: 1, id, ok: "true", result: null })],
  ["missing result", (id: string) => ({ protocolVersion: 1, id, ok: true })],
  ["invalid error", (id: string) => ({ protocolVersion: 1, id, ok: false, error: { code: 5, message: "failure" } })],
  ["invalid uncertainty flag", (id: string) => ({ protocolVersion: 1, id, ok: false, error: { code: "VERIFY_FAILED", message: "failure", outcomeUncertain: "false" } })],
] as const) {
  test(`malformed response: ${name}`, async (t) => {
    const { directory, bridge } = await fixture(t);
    const peer = (async () => {
      const request = await nextRequest(directory);
      await respond(directory, request, makeResponse(request.id));
    })();
    await assert.rejects(bridge.call("adjust"), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "BRIDGE_PROTOCOL_ERROR");
      assert.equal(error.outcomeUncertain, true);
      return true;
    });
    await peer;
    assert.equal((await readdir(join(directory, "responses"))).length, 1, "Keep invalid response as evidence");
  });
}

test("timeout preserves the mutation request without retry and reports an uncertain outcome", async (t) => {
  const { directory } = await fixture(t);
  const bridge = new FileBridge(directory, { timeoutMs: 35, pollMs: 3 });
  let requestId: string | undefined;
  await assert.rejects(bridge.call("adjust", { exposure: 1 }), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "BRIDGE_TIMEOUT");
    assert.equal(error.outcomeUncertain, true);
    assert.match(error.message, /may still execute/);
    assert.match(error.message, /Reconcile/);
    requestId = error.requestId;
    return true;
  });
  assert.deepEqual(await readdir(join(directory, "requests")), [`${requestId}.json`]);
  const request = JSON.parse(await readFile(join(directory, "requests", `${requestId}.json`), "utf8"));
  assert.equal(request.operation, "adjust");
  assert.ok(request.deadlineAt <= Date.now());
  assert.ok(!(await readdir(directory)).includes("call.lock"));
});

test("independent bridge instances cannot submit concurrently", async (t) => {
  const { directory, bridge } = await fixture(t);
  const pending = bridge.call("first");
  const first = await nextRequest(directory);
  const another = new FileBridge(directory, { timeoutMs: 1_000, pollMs: 5 });
  await assert.rejects(another.call("second"), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "BRIDGE_BUSY");
    assert.equal(error.outcomeUncertain, false);
    return true;
  });
  assert.deepEqual(await readdir(join(directory, "requests")), [`${first.id}.json`]);
  await respond(directory, first, { protocolVersion: 1, id: first.id, ok: true, result: "done" });
  assert.equal(await pending, "done");

  const secondPeer = (async () => {
    const request = await nextRequest(directory);
    await respond(directory, request, { protocolVersion: 1, id: request.id, ok: true, result: "next" });
  })();
  assert.equal(await another.call("after_unlock"), "next");
  await secondPeer;
});

test("an abandoned lock is never silently broken", async (t) => {
  const { directory, bridge } = await fixture(t);
  const lock = JSON.stringify({ id: "previous", pid: 999_999_999, timestamp: 0 });
  await writeFile(join(directory, "call.lock"), lock, { mode: 0o600 });
  await assert.rejects(bridge.call("adjust"), (error: unknown) => error instanceof BridgeError && error.code === "BRIDGE_BUSY");
  assert.equal(await readFile(join(directory, "call.lock"), "utf8"), lock);
  assert.deepEqual(await readdir(join(directory, "requests")), []);
});

test("the lock also excludes a separate Node process", async (t) => {
  const { directory, bridge } = await fixture(t);
  const pending = bridge.call("parent_edit");
  const first = await nextRequest(directory);
  const moduleURL = new URL("../src/bridge.ts", import.meta.url).href;
  const script = `
    import { FileBridge } from ${JSON.stringify(moduleURL)};
    try {
      await new FileBridge(process.argv[1], { timeoutMs: 200 }).call("child_edit");
      process.exitCode = 2;
    } catch (error) {
      process.stdout.write(JSON.stringify({ code: error.code, uncertain: error.outcomeUncertain }));
    }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, directory]);
  assert.deepEqual(JSON.parse(stdout), { code: "BRIDGE_BUSY", uncertain: false });
  assert.deepEqual(await readdir(join(directory, "requests")), [`${first.id}.json`]);
  const lock = JSON.parse(await readFile(join(directory, "call.lock"), "utf8"));
  assert.equal(lock.pid, process.pid);
  await respond(directory, first, { protocolVersion: 1, id: first.id, ok: true, result: null });
  assert.equal(await pending, null);
});

test("status distinguishes fresh, stale, invalid, and missing heartbeats", async (t) => {
  const { directory, bridge } = await fixture(t);
  assert.equal((await bridge.status()).online, false);
  const heartbeat = { timestamp: Date.now(), status: "idle", pluginVersion: "0.1.0" };
  await writeFile(join(directory, "heartbeat.json"), JSON.stringify(heartbeat));
  assert.deepEqual(await bridge.status(), { online: true, heartbeat, bridgeDir: directory });
  await writeFile(join(directory, "heartbeat.json"), JSON.stringify({ timestamp: Date.now() - 60_000, status: "idle" }));
  assert.equal((await bridge.status()).online, false);
  await writeFile(join(directory, "heartbeat.json"), JSON.stringify({ timestamp: "now", status: "idle" }));
  assert.equal((await bridge.status()).online, false);
  await writeFile(join(directory, "heartbeat.json"), "incomplete json");
  assert.equal((await bridge.status()).online, false);
});

test("a fresh heartbeat is online only while the worker is idle or busy", async (t) => {
  const { directory, bridge } = await fixture(t);
  for (const status of ["idle", "busy", "stopped", "error", "starting", "unknown", null, undefined]) {
    const heartbeat = { timestamp: Date.now(), pluginVersion: "0.1.0", status };
    await writeFile(join(directory, "heartbeat.json"), JSON.stringify(heartbeat));
    const observed = await bridge.status();
    assert.equal(observed.online, status === "idle" || status === "busy", `Worker status: ${String(status)}`);
    assert.deepEqual(observed.heartbeat, JSON.parse(JSON.stringify(heartbeat)));
  }
});
