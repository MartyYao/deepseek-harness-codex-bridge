import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { CodexBridge } from "../src/bridge.js";
import { resolveConfig } from "../src/config.js";
import { ThreadMap } from "../src/thread.js";
import { runCodexTurn } from "../src/tools.js";
import { MockWebSocket, driveConnect, flush } from "./helpers/mock-ws.js";

const ctx = { tools: { schemas: () => [] } };

function setup(configOverrides = {}) {
	const bridge = new CodexBridge({
		url: "ws://127.0.0.1:4500",
		clientInfo: { name: "test", version: "0" },
		connectTimeoutMs: 100,
		requestTimeoutMs: 200,
		WebSocketImpl: MockWebSocket
	});
	const threads = new ThreadMap();
	const config = resolveConfig({ turnTimeoutMs: 500, ...configOverrides });
	return { bridge, threads, config };
}

function args(overrides = {}) {
	return { prompt: "do the thing", sessionKey: "s1", ...overrides };
}

/** Answer the request the bridge just sent and return it. */
async function answerNext(ws, method, result) {
	await flush();
	const request = ws.sent.filter((message) => message.method === method).at(-1);
	assert.ok(request, `expected a ${method} request, sent: ${JSON.stringify(ws.sent)}`);
	ws.serverSend({ id: request.id, result });
	return request;
}

beforeEach(() => MockWebSocket.reset());

test("happy path: thread/start + turn/start + event stream -> final text with thread_id", async () => {
	const { bridge, threads, config } = setup();
	const run = runCodexTurn({ bridge, threads, config, ctx, args: args(), signal: new AbortController().signal });
	const ws = await driveConnect(bridge);
	const startReq = await answerNext(ws, "thread/start", { thread: { id: "th_1" }, model: "gpt-5.6-terra" });
	assert.equal(startReq.params.model, "gpt-5.6-terra");
	assert.equal(startReq.params.sandbox, "read-only");
	assert.equal(startReq.params.approvalPolicy, "never");
	assert.equal(startReq.params.dynamicTools, undefined); // empty whitelist -> omitted
	const turnReq = await answerNext(ws, "turn/start", { turn: { id: "t1" } });
	assert.deepEqual(turnReq.params.input, [{ type: "text", text: "do the thing" }]);
	ws.serverSend({ method: "turn/started", params: { threadId: "th_1", turn: { id: "t1" } } });
	ws.serverSend({ method: "item/agentMessage/delta", params: { threadId: "th_1", turnId: "t1", itemId: "a1", delta: "任务完成" } });
	ws.serverSend({ method: "turn/completed", params: { threadId: "th_1", turn: { id: "t1", status: "completed", items: [] } } });
	const value = await run;
	assert.equal(value.status, "completed");
	assert.equal(value.threadId, "th_1");
	assert.match(value.text, /任务完成/);
	assert.match(value.text, /codex thread_id: th_1/);
	assert.equal(threads.get("s1"), "th_1");
});

test("second call in the same session resumes the mapped thread", async () => {
	const { bridge, threads, config } = setup();
	threads.set("s1", "th_existing");
	const run = runCodexTurn({ bridge, threads, config, ctx, args: args(), signal: new AbortController().signal });
	const ws = await driveConnect(bridge);
	const resumeReq = await answerNext(ws, "thread/resume", { thread: { id: "th_existing" } });
	assert.equal(resumeReq.params.threadId, "th_existing");
	await answerNext(ws, "turn/start", { turn: { id: "t2" } });
	ws.serverSend({ method: "turn/completed", params: { threadId: "th_existing", turn: { id: "t2", status: "completed", items: [] } } });
	const value = await run;
	assert.equal(value.threadId, "th_existing");
	assert.equal(ws.sent.some((message) => message.method === "thread/start"), false);
});

test("explicit thread_id arg wins over the session mapping", async () => {
	const { bridge, threads, config } = setup();
	threads.set("s1", "th_mapped");
	const run = runCodexTurn({ bridge, threads, config, ctx, args: args({ thread_id: "th_explicit" }), signal: new AbortController().signal });
	const ws = await driveConnect(bridge);
	const resumeReq = await answerNext(ws, "thread/resume", { thread: { id: "th_explicit" } });
	assert.equal(resumeReq.params.threadId, "th_explicit");
	await answerNext(ws, "turn/start", { turn: { id: "t3" } });
	ws.serverSend({ method: "turn/completed", params: { threadId: "th_explicit", turn: { id: "t3", status: "completed", items: [] } } });
	await run;
	assert.equal(threads.get("s1"), "th_explicit");
});

test("stale mapping: thread/resume error -> thread/start fallback", async () => {
	const { bridge, threads, config } = setup();
	threads.set("s1", "th_gone");
	const run = runCodexTurn({ bridge, threads, config, ctx, args: args(), signal: new AbortController().signal });
	const ws = await driveConnect(bridge);
	await flush();
	const resumeReq = ws.sent.find((message) => message.method === "thread/resume");
	ws.serverSend({ id: resumeReq.id, error: { code: -32602, message: "thread not found" } });
	await answerNext(ws, "thread/start", { thread: { id: "th_new" } });
	await answerNext(ws, "turn/start", { turn: { id: "t5" } });
	ws.serverSend({ method: "turn/completed", params: { threadId: "th_new", turn: { id: "t5", status: "completed", items: [] } } });
	const value = await run;
	assert.equal(value.threadId, "th_new");
	assert.match(value.text, /已开启新会话/);
});

test("failed turn rejects with a classified error", async () => {
	const { bridge, threads, config } = setup();
	const run = runCodexTurn({ bridge, threads, config, ctx, args: args(), signal: new AbortController().signal });
	const ws = await driveConnect(bridge);
	await answerNext(ws, "thread/start", { thread: { id: "th_1" } });
	await answerNext(ws, "turn/start", { turn: { id: "t1" } });
	ws.serverSend({ method: "turn/completed", params: { threadId: "th_1", turn: { id: "t1", status: "failed", error: { message: "usage limit" }, items: [] } } });
	await assert.rejects(run, /codex turn failed: usage limit/);
});

test("turn without turn/completed rejects with a timeout error", async () => {
	const { bridge, threads, config } = setup();
	const run = runCodexTurn({ bridge, threads, config, ctx, args: args(), signal: new AbortController().signal });
	const ws = await driveConnect(bridge);
	await answerNext(ws, "thread/start", { thread: { id: "th_1" } });
	await answerNext(ws, "turn/start", { turn: { id: "t1" } });
	await assert.rejects(run, /超时/);
});

test("dsh-side cancellation sends turn/interrupt and rejects", async () => {
	const { bridge, threads, config } = setup();
	const controller = new AbortController();
	const run = runCodexTurn({ bridge, threads, config, ctx, args: args(), signal: controller.signal });
	const ws = await driveConnect(bridge);
	await answerNext(ws, "thread/start", { thread: { id: "th_1" } });
	await answerNext(ws, "turn/start", { turn: { id: "t1" } });
	controller.abort();
	await assert.rejects(run, /取消/);
	await flush();
	const interrupt = ws.sent.find((message) => message.method === "turn/interrupt");
	assert.ok(interrupt);
	assert.deepEqual(interrupt.params, { threadId: "th_1", turnId: "t1" });
});

test("turn timeout sends turn/interrupt so the server-side turn does not run on", async () => {
	const { bridge, threads, config } = setup();
	const run = runCodexTurn({ bridge, threads, config, ctx, args: args(), signal: new AbortController().signal });
	const ws = await driveConnect(bridge);
	await answerNext(ws, "thread/start", { thread: { id: "th_1" } });
	await answerNext(ws, "turn/start", { turn: { id: "t1" } });
	await assert.rejects(run, /超时.*turn\/interrupt/);
	const interrupt = ws.sent.find((message) => message.method === "turn/interrupt");
	assert.ok(interrupt);
	assert.deepEqual(interrupt.params, { threadId: "th_1", turnId: "t1" });
});

test("socket close during a turn rejects the run immediately instead of waiting out the timeout", async () => {
	const { bridge, threads, config } = setup({ turnTimeoutMs: 60_000 });
	const run = runCodexTurn({ bridge, threads, config, ctx, args: args(), signal: new AbortController().signal });
	const ws = await driveConnect(bridge);
	await answerNext(ws, "thread/start", { thread: { id: "th_1" } });
	await answerNext(ws, "turn/start", { turn: { id: "t1" } });
	ws.serverClose();
	await assert.rejects(run, /连接已关闭/);
});

test("runCodexTurn publishes the active turn context and cleans it up at turn end", async () => {
	const { bridge, threads, config } = setup();
	const activeTurns = new Map();
	const agent = { id: "agent-1" };
	const run = runCodexTurn({
		bridge, threads, config, ctx, args: args(),
		signal: new AbortController().signal,
		activeTurns,
		callContext: { agent, rootCallId: "root-1" }
	});
	const ws = await driveConnect(bridge);
	await answerNext(ws, "thread/start", { thread: { id: "th_1" } });
	await answerNext(ws, "turn/start", { turn: { id: "t1" } });
	await flush();
	const active = activeTurns.get("th_1");
	assert.ok(active);
	assert.equal(active.agent, agent);
	assert.equal(active.rootCallId, "root-1");
	assert.equal(active.signal.aborted, false);
	ws.serverSend({ method: "turn/completed", params: { threadId: "th_1", turn: { id: "t1", status: "completed", items: [] } } });
	await run;
	assert.equal(activeTurns.size, 0);
	// Turn end aborts the tool signal so dangling dsh tool executions stop.
	assert.equal(active.signal.aborted, true);
});

test("dsh-side abort propagates to the active turn tool signal", async () => {
	const { bridge, threads, config } = setup();
	const activeTurns = new Map();
	const controller = new AbortController();
	const run = runCodexTurn({ bridge, threads, config, ctx, args: args(), signal: controller.signal, activeTurns });
	const ws = await driveConnect(bridge);
	await answerNext(ws, "thread/start", { thread: { id: "th_1" } });
	await answerNext(ws, "turn/start", { turn: { id: "t1" } });
	await flush();
	const active = activeTurns.get("th_1");
	controller.abort();
	assert.equal(active.signal.aborted, true);
	await assert.rejects(run, /取消/);
	assert.equal(activeTurns.size, 0);
});

test("thread/start passes cwd when configured and omits it when null", async () => {
	const withCwd = setup({ cwd: "/tmp/work" });
	const run = runCodexTurn({ bridge: withCwd.bridge, threads: withCwd.threads, config: withCwd.config, ctx, args: args(), signal: new AbortController().signal });
	const ws = await driveConnect(withCwd.bridge);
	const startReq = await answerNext(ws, "thread/start", { thread: { id: "th_1" } });
	assert.equal(startReq.params.cwd, "/tmp/work");
	await answerNext(ws, "turn/start", { turn: { id: "t1" } });
	ws.serverSend({ method: "turn/completed", params: { threadId: "th_1", turn: { id: "t1", status: "completed", items: [] } } });
	await run;

	const withoutCwd = setup();
	const run2 = runCodexTurn({ bridge: withoutCwd.bridge, threads: withoutCwd.threads, config: withoutCwd.config, ctx, args: args(), signal: new AbortController().signal });
	const ws2 = await driveConnect(withoutCwd.bridge);
	const startReq2 = await answerNext(ws2, "thread/start", { thread: { id: "th_2" } });
	assert.equal("cwd" in startReq2.params, false);
	await answerNext(ws2, "turn/start", { turn: { id: "t2" } });
	ws2.serverSend({ method: "turn/completed", params: { threadId: "th_2", turn: { id: "t2", status: "completed", items: [] } } });
	await run2;
});

test("connect failure rejects with actionable text", async () => {
	const { bridge, threads, config } = setup();
	const run = runCodexTurn({ bridge, threads, config, ctx, args: args(), signal: new AbortController().signal });
	await flush();
	MockWebSocket.latest().serverError("connection refused");
	await assert.rejects(run, /无法连接 app-server/);
});

test("dynamicTools whitelist is translated onto thread/start", async () => {
	const { bridge, threads, config } = setup({ dynamicTools: ["bash"] });
	const ctxWithTools = {
		tools: {
			schemas: () => [{ name: "bash", description: "run", parameters: { type: "object", properties: {} } }]
		}
	};
	const run = runCodexTurn({ bridge, threads, config, ctx: ctxWithTools, args: args(), signal: new AbortController().signal });
	const ws = await driveConnect(bridge);
	const startReq = await answerNext(ws, "thread/start", { thread: { id: "th_1" } });
	assert.deepEqual(startReq.params.dynamicTools, [
		{ type: "function", name: "dsh_bash", description: "run", inputSchema: { type: "object", properties: {} } }
	]);
	await answerNext(ws, "turn/start", { turn: { id: "t1" } });
	ws.serverSend({ method: "turn/completed", params: { threadId: "th_1", turn: { id: "t1", status: "completed", items: [] } } });
	await run;
});
