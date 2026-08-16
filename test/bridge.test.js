import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { BridgeError, CodexBridge } from "../src/bridge.js";
import { MockWebSocket, driveConnect, flush } from "./helpers/mock-ws.js";

const CLIENT_INFO = { name: "test-client", version: "0.0.0" };

function makeBridge(options = {}) {
	return new CodexBridge({
		url: "ws://127.0.0.1:4500",
		clientInfo: CLIENT_INFO,
		connectTimeoutMs: 100,
		requestTimeoutMs: 100,
		WebSocketImpl: MockWebSocket,
		...options
	});
}

beforeEach(() => MockWebSocket.reset());

test("connect performs the initialize handshake with experimentalApi", async () => {
	const bridge = makeBridge();
	const ws = await driveConnect(bridge);
	assert.equal(bridge.connected, true);
	const init = ws.sent.find((message) => message.method === "initialize");
	assert.deepEqual(init.params.clientInfo, CLIENT_INFO);
	assert.equal(init.params.capabilities.experimentalApi, true);
	// initialized notification follows the response, without an id.
	const initialized = ws.sent.find((message) => message.method === "initialized");
	assert.ok(initialized);
	assert.equal(initialized.id, undefined);
	assert.equal(bridge.serverInfo.userAgent, "mock-codex/0.0.0");
});

test("request/response pairs match by id, out of order", async () => {
	const bridge = makeBridge();
	const ws = await driveConnect(bridge);
	const first = bridge.request("thread/start", { model: "m" });
	const second = bridge.request("model/list");
	await flush();
	const [reqA, reqB] = ws.sent.filter((message) => message.method !== "initialize" && message.method !== "initialized");
	// Answer in reverse order.
	ws.serverSend({ id: reqB.id, result: { data: ["gpt-x"] } });
	ws.serverSend({ id: reqA.id, result: { thread: { id: "th_1" } } });
	assert.deepEqual(await first, { thread: { id: "th_1" } });
	assert.deepEqual(await second, { data: ["gpt-x"] });
});

test("rpc errors reject with kind 'rpc' and the server message", async () => {
	const bridge = makeBridge();
	const ws = await driveConnect(bridge);
	const pending = bridge.request("thread/resume", { threadId: "th_gone" });
	await flush();
	const request = ws.sent.find((message) => message.method === "thread/resume");
	ws.serverSend({ id: request.id, error: { code: -32602, message: "thread not found" } });
	await assert.rejects(pending, (error) => {
		assert.ok(error instanceof BridgeError);
		assert.equal(error.kind, "rpc");
		assert.match(error.message, /thread not found/);
		return true;
	});
});

test("requests time out with kind 'timeout'", async () => {
	const bridge = makeBridge();
	await driveConnect(bridge);
	await assert.rejects(bridge.request("turn/start", {}), (error) => {
		assert.equal(error.kind, "timeout");
		assert.match(error.message, /turn\/start timed out/);
		return true;
	});
});

test("connect failure before open rejects with kind 'connect'", async () => {
	const bridge = makeBridge();
	const pending = bridge.connect();
	await flush();
	MockWebSocket.latest().serverError("connection refused");
	await assert.rejects(pending, (error) => {
		assert.equal(error.kind, "connect");
		assert.match(error.message, /connection refused/);
		return true;
	});
});

test("notifications route to listeners; other sockets' messages ignored", async () => {
	const bridge = makeBridge();
	const ws = await driveConnect(bridge);
	const seen = [];
	const off = bridge.onNotification((method, params) => seen.push([method, params]));
	ws.serverSend({ method: "item/agentMessage/delta", params: { threadId: "th_1", itemId: "i1", delta: "你好" } });
	ws.serverSend({ method: "turn/completed", params: { threadId: "th_1", turn: { id: "t1", status: "completed", items: [] } } });
	off();
	ws.serverSend({ method: "item/agentMessage/delta", params: { threadId: "th_1", itemId: "i1", delta: "!" } });
	assert.equal(seen.length, 2);
	assert.equal(seen[0][1].delta, "你好");
});

test("server requests are answered with the handler result", async () => {
	const bridge = makeBridge();
	const ws = await driveConnect(bridge);
	bridge.onServerRequest(async (method, params) => {
		assert.equal(method, "item/tool/call");
		return { contentItems: [{ type: "inputText", text: `echo:${params.tool}` }], success: true };
	});
	ws.serverSend({ id: "srv-1", method: "item/tool/call", params: { callId: "c1", threadId: "th_1", turnId: "t1", tool: "dsh_bash", arguments: {} } });
	await flush();
	const response = ws.sent.find((message) => message.id === "srv-1");
	assert.deepEqual(response.result, { contentItems: [{ type: "inputText", text: "echo:dsh_bash" }], success: true });
});

test("server request handler errors become JSON-RPC error responses", async () => {
	const bridge = makeBridge();
	const ws = await driveConnect(bridge);
	bridge.onServerRequest(async () => {
		throw new Error("boom");
	});
	ws.serverSend({ id: 42, method: "item/tool/call", params: {} });
	await flush();
	const response = ws.sent.find((message) => message.id === 42);
	assert.equal(response.error.code, -32603);
	assert.match(response.error.message, /boom/);
});

test("unhandled server requests get a -32601 response instead of hanging", async () => {
	const bridge = makeBridge();
	const ws = await driveConnect(bridge);
	ws.serverSend({ id: 7, method: "item/commandExecution/requestApproval", params: {} });
	await flush();
	const response = ws.sent.find((message) => message.id === 7);
	assert.equal(response.error.code, -32601);
});

test("socket close rejects in-flight requests with kind 'closed'", async () => {
	const bridge = makeBridge();
	const ws = await driveConnect(bridge);
	const pending = bridge.request("turn/start", {});
	await flush();
	ws.serverClose();
	await assert.rejects(pending, (error) => {
		assert.equal(error.kind, "closed");
		return true;
	});
	assert.equal(bridge.connected, false);
});

test("requests before any connection reject immediately", async () => {
	const bridge = makeBridge();
	await assert.rejects(bridge.request("model/list"), (error) => {
		assert.equal(error.kind, "closed");
		return true;
	});
});

test("server-request responses are dropped silently when the socket closes mid-handler", async () => {
	const bridge = makeBridge();
	const ws = await driveConnect(bridge);
	let release;
	bridge.onServerRequest(() => new Promise((resolve) => {
		release = () => resolve({ ok: true });
	}));
	ws.serverSend({ id: "srv-9", method: "item/tool/call", params: {} });
	await flush();
	ws.serverClose();
	release();
	await flush();
	// No response frame, and no unhandled rejection from the dead-socket send.
	assert.equal(ws.sent.some((message) => message.id === "srv-9"), false);
	assert.equal(bridge.connected, false);
});

test("server-request responses are not sent on a closing socket", async () => {
	const bridge = makeBridge();
	const ws = await driveConnect(bridge);
	bridge.onServerRequest(async () => ({ ok: true }));
	// The close event has not been delivered yet, but the socket is no longer open.
	ws.readyState = MockWebSocket.CLOSING;
	ws.serverSend({ id: "srv-10", method: "item/tool/call", params: {} });
	await flush();
	assert.equal(ws.sent.some((message) => message.id === "srv-10"), false);
});

test("onClose listeners fire with a 'closed' BridgeError and can be disposed", async () => {
	const bridge = makeBridge();
	const ws = await driveConnect(bridge);
	const seen = [];
	const off = bridge.onClose((error) => seen.push(error));
	ws.serverClose();
	assert.equal(seen.length, 1);
	assert.ok(seen[0] instanceof BridgeError);
	assert.equal(seen[0].kind, "closed");
	off();
	// Reconnect, close again: the disposed listener must not fire.
	const ws2 = await driveConnect(bridge);
	ws2.serverClose();
	assert.equal(seen.length, 1);
});

test("a stale socket's late close event does not tear down the new connection", async () => {
	const bridge = makeBridge();
	const ws1 = await driveConnect(bridge);
	bridge.close();
	const ws2 = await driveConnect(bridge);
	assert.notEqual(ws1, ws2);
	const pending = bridge.request("model/list");
	await flush();
	// Native sockets deliver close asynchronously; simulate the old socket's
	// close arriving after the reconnect.
	ws1._emit("close", {});
	assert.equal(bridge.connected, true);
	const request = ws2.sent.find((message) => message.method === "model/list");
	ws2.serverSend({ id: request.id, result: { data: [] } });
	assert.deepEqual(await pending, { data: [] });
});

test("frames from a stale socket are ignored after reconnect", async () => {
	const bridge = makeBridge();
	const ws1 = await driveConnect(bridge);
	bridge.close();
	const ws2 = await driveConnect(bridge);
	const pending = bridge.request("model/list");
	await flush();
	const request = ws2.sent.find((message) => message.method === "model/list");
	ws1.serverSend({ id: request.id, result: { data: ["stale"] } });
	ws2.serverSend({ id: request.id, result: { data: ["fresh"] } });
	assert.deepEqual(await pending, { data: ["fresh"] });
});

// ---- idle auto-close ----

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("idle timeout closes the connection and cleans up the timer", async () => {
	const bridge = makeBridge({ idleTimeoutMs: 60 });
	const ws = await driveConnect(bridge);
	assert.equal(bridge.connected, true);
	assert.ok(bridge._idleTimer !== null, "idle timer armed after connect");
	await sleep(150);
	assert.equal(bridge.connected, false);
	assert.equal(ws.readyState, MockWebSocket.CLOSED);
	assert.equal(bridge._idleTimer, null, "idle timer cleared after firing");
});

test("request/response activity resets the idle countdown", async () => {
	const bridge = makeBridge({ idleTimeoutMs: 100, requestTimeoutMs: 1_000 });
	const ws = await driveConnect(bridge);
	await sleep(60);
	const pending = bridge.request("model/list");
	await flush();
	const request = ws.sent.find((message) => message.method === "model/list");
	ws.serverSend({ id: request.id, result: { data: [] } });
	await pending;
	await sleep(60); // 120ms since connect, but only ~60ms since last activity
	assert.equal(bridge.connected, true);
	await sleep(100); // now past the idle budget
	assert.equal(bridge.connected, false);
});

test("notification frames count as activity", async () => {
	const bridge = makeBridge({ idleTimeoutMs: 100 });
	const ws = await driveConnect(bridge);
	await sleep(60);
	ws.serverSend({ method: "thread/name/updated", params: { threadId: "th_1" } });
	await sleep(60);
	assert.equal(bridge.connected, true);
	await sleep(100);
	assert.equal(bridge.connected, false);
});

test("a connection is re-established lazily after an idle close", async () => {
	const bridge = makeBridge({ idleTimeoutMs: 50 });
	await driveConnect(bridge);
	await sleep(120);
	assert.equal(bridge.connected, false);
	// The existing on-demand connect path re-opens the socket + handshake.
	const ws2 = await driveConnect(bridge);
	assert.equal(MockWebSocket.instances.length, 2);
	assert.equal(bridge.connected, true);
	const pending = bridge.request("model/list");
	await flush();
	const request = ws2.sent.find((message) => message.method === "model/list");
	ws2.serverSend({ id: request.id, result: { data: ["gpt-x"] } });
	assert.deepEqual(await pending, { data: ["gpt-x"] });
	bridge.close();
});

test("in-flight requests hold off the idle close", async () => {
	const bridge = makeBridge({ idleTimeoutMs: 60, requestTimeoutMs: 500 });
	await driveConnect(bridge);
	const pending = bridge.request("turn/start", {}); // never answered
	await flush();
	await sleep(150); // idle timer fired but rescheduled: request still pending
	assert.equal(bridge.connected, true);
	await assert.rejects(pending, (error) => error.kind === "timeout");
	bridge.close();
});

test("live notification listeners (an active turn) hold off the idle close", async () => {
	const bridge = makeBridge({ idleTimeoutMs: 60 });
	await driveConnect(bridge);
	const off = bridge.onNotification(() => {});
	await sleep(150); // idle timer fired but rescheduled while the listener lives
	assert.equal(bridge.connected, true);
	off();
	await sleep(150); // already-armed countdown now fires
	assert.equal(bridge.connected, false);
});

test("manual close disarms the idle timer", async () => {
	const bridge = makeBridge({ idleTimeoutMs: 60 });
	await driveConnect(bridge);
	assert.ok(bridge._idleTimer !== null);
	bridge.close();
	assert.equal(bridge._idleTimer, null);
});

test("idle close can be disabled with a non-positive idleTimeoutMs", async () => {
	const bridge = makeBridge({ idleTimeoutMs: 0 });
	await driveConnect(bridge);
	assert.equal(bridge._idleTimer, null);
	await sleep(120);
	assert.equal(bridge.connected, true);
	bridge.close();
});

test("the default idle timeout is 30 seconds", () => {
	const bridge = makeBridge();
	assert.equal(bridge.idleTimeoutMs, 30_000);
});
