import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/config.js";
import { ThreadMap } from "../src/thread.js";
import { executeDshTool, translateDynamicTools } from "../src/tools.js";

test("resolveConfig applies defaults", () => {
	const config = resolveConfig();
	assert.equal(config.appServerUrl, "ws://127.0.0.1:4500");
	assert.equal(config.defaultModel, "gpt-5.6-terra");
	assert.equal(config.sandbox, "read-only");
	assert.deepEqual(config.dynamicTools, []);
});

test("resolveConfig rejects bad enums and urls", () => {
	assert.throws(() => resolveConfig({ sandbox: "yolo" }), /sandbox must be one of/);
	assert.throws(() => resolveConfig({ approvalPolicy: "always" }), /approvalPolicy must be one of/);
	assert.throws(() => resolveConfig({ appServerUrl: "http://x" }), /appServerUrl must be a ws/);
	assert.throws(() => resolveConfig({ dynamicTools: "bash" }), /dynamicTools must be an array/);
	assert.throws(() => resolveConfig({ turnTimeoutMs: -1 }), /turnTimeoutMs must be a positive number/);
});

test("resolveConfig accepts a string or null cwd and rejects other types", () => {
	assert.equal(resolveConfig({ cwd: null }).cwd, null);
	assert.equal(resolveConfig({ cwd: "/tmp/work" }).cwd, "/tmp/work");
	assert.throws(() => resolveConfig({ cwd: 42 }), /cwd must be a string or null/);
});

test("ThreadMap stores and deletes per-session thread ids", () => {
	const map = new ThreadMap();
	assert.equal(map.get("s1"), undefined);
	map.set("s1", "th_1");
	map.set("s2", "th_2");
	assert.equal(map.get("s1"), "th_1");
	map.delete("s1");
	assert.equal(map.get("s1"), undefined);
	assert.equal(map.get("s2"), "th_2");
});

test("ThreadMap evicts the least recently used entry beyond the cap", () => {
	const map = new ThreadMap(2);
	map.set("a", "th_a");
	map.set("b", "th_b");
	assert.equal(map.get("a"), "th_a"); // refresh a; b is now the oldest
	map.set("c", "th_c"); // over the cap: evicts b
	assert.equal(map.get("a"), "th_a");
	assert.equal(map.get("b"), undefined);
	assert.equal(map.get("c"), "th_c");
});

test("runSerialized drains its queue entry after settling", async () => {
	const map = new ThreadMap();
	await map.runSerialized("k", async () => {});
	// The cleanup callback runs as a microtask after the queue tail settles.
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(map._queues.size, 0);
});

test("runSerialized serializes per key and isolates failures", async () => {
	const map = new ThreadMap();
	const order = [];
	const slow = map.runSerialized("k", async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
		order.push("slow");
		return "a";
	});
	const fast = map.runSerialized("k", async () => {
		order.push("fast");
		return "b";
	});
	assert.equal(await slow, "a");
	assert.equal(await fast, "b");
	assert.deepEqual(order, ["slow", "fast"]);
	// A rejection does not poison the queue.
	await assert.rejects(map.runSerialized("k", async () => {
		throw new Error("nope");
	}));
	assert.equal(await map.runSerialized("k", async () => "after"), "after");
	// Different keys run independently.
	const started = [];
	await Promise.all([
		map.runSerialized("x", async () => { started.push("x"); }),
		map.runSerialized("y", async () => { started.push("y"); })
	]);
	assert.equal(started.length, 2);
});

test("translateDynamicTools prefixes, whitelists, and excludes the codex tool itself", () => {
	const schemas = [
		{ name: "bash", description: "run commands", parameters: { type: "object" } },
		{ name: "codex", description: "self", parameters: { type: "object" } },
		{ name: "fs/read", description: "slash in name", parameters: { type: "object" } },
		{ name: "web_search", description: "search", parameters: { type: "object" } }
	];
	const specs = translateDynamicTools(schemas, ["bash", "codex", "fs/read", "web_search"], "dsh_");
	assert.deepEqual(specs.map((spec) => spec.name), ["dsh_bash", "dsh_web_search"]);
	assert.equal(specs[0].type, "function");
	assert.deepEqual(specs[0].inputSchema, { type: "object" });
	// Empty whitelist exposes nothing.
	assert.deepEqual(translateDynamicTools(schemas, [], "dsh_"), []);
});

function fakeCtx(handlers) {
	return {
		tools: {
			async execute(exec) {
				const handler = handlers[exec.name];
				if (handler === undefined) return { isError: true, content: [{ type: "text", text: `unknown tool ${exec.name}` }] };
				return handler(exec.arguments, exec);
			}
		}
	};
}

test("executeDshTool maps prefixed names back to ctx.tools and flattens content", async () => {
	const ctx = fakeCtx({
		echo: (args) => ({ isError: false, content: [{ type: "text", text: `echo:${args.text}` }] })
	});
	const outcome = await executeDshTool(ctx, {
		tool: "dsh_echo",
		args: { text: "hi" },
		prefix: "dsh_",
		whitelist: ["echo"],
		callId: "c1"
	});
	assert.equal(outcome.success, true);
	assert.match(outcome.text, /^echo:hi/);
	assert.match(outcome.text, /未经过 dsh 人工审批/);
});

test("executeDshTool enforces the whitelist and reports tool errors", async () => {
	const ctx = fakeCtx({
		bash: () => ({ isError: true, content: [{ type: "text", text: "sandbox denied" }] })
	});
	const blocked = await executeDshTool(ctx, { tool: "dsh_bash", args: {}, prefix: "dsh_", whitelist: [], callId: "c2" });
	assert.equal(blocked.success, false);
	assert.match(blocked.text, /not in the .* whitelist/);
	const failed = await executeDshTool(ctx, { tool: "dsh_bash", args: {}, prefix: "dsh_", whitelist: ["bash"], callId: "c3" });
	assert.equal(failed.success, false);
	assert.match(failed.text, /^sandbox denied/);
});

test("executeDshTool accepts JSON-string arguments", async () => {
	const ctx = fakeCtx({
		echo: (args) => ({ isError: false, content: [{ type: "text", text: JSON.stringify(args) }] })
	});
	const outcome = await executeDshTool(ctx, {
		tool: "dsh_echo",
		args: "{\"a\":1}",
		prefix: "dsh_",
		whitelist: ["echo"],
		callId: "c4"
	});
	assert.match(outcome.text, /^{"a":1}/);
	const invalid = await executeDshTool(ctx, { tool: "dsh_echo", args: "{nope", prefix: "dsh_", whitelist: ["echo"], callId: "c5" });
	assert.equal(invalid.success, false);
	assert.match(invalid.text, /not valid JSON/);
});

test("executeDshTool blocks the codex self-tool even when whitelisted (recursion guard)", async () => {
	let dispatched = false;
	const ctx = {
		tools: {
			async execute() {
				dispatched = true;
				return { isError: false, content: [{ type: "text", text: "should not happen" }] };
			}
		}
	};
	const outcome = await executeDshTool(ctx, { tool: "dsh_codex", args: {}, prefix: "dsh_", whitelist: ["codex"], callId: "c6" });
	assert.equal(outcome.success, false);
	assert.match(outcome.text, /recursive invocation is forbidden/);
	assert.equal(dispatched, false);
});

test("executeDshTool forwards agent, rootCallId, and signal to ctx.tools.execute", async () => {
	let seen;
	const ctx = {
		tools: {
			async execute(exec) {
				seen = exec;
				return { isError: false, content: [{ type: "text", text: "ok" }] };
			}
		}
	};
	const agent = { id: "agent-1" };
	const controller = new AbortController();
	await executeDshTool(ctx, {
		tool: "dsh_echo",
		args: {},
		prefix: "dsh_",
		whitelist: ["echo"],
		callId: "c7",
		agent,
		rootCallId: "root-1",
		signal: controller.signal
	});
	assert.equal(seen.agent, agent);
	assert.equal(seen.rootCallId, "root-1");
	assert.equal(seen.signal, controller.signal);
	assert.equal(seen.callId, "dsh-codex-bridge:c7");
});

test("executeDshTool falls back to a standalone signal when none is given", async () => {
	let seen;
	const ctx = {
		tools: {
			async execute(exec) {
				seen = exec;
				return { isError: false, content: [{ type: "text", text: "ok" }] };
			}
		}
	};
	await executeDshTool(ctx, { tool: "dsh_echo", args: {}, prefix: "dsh_", whitelist: ["echo"], callId: "c8" });
	assert.ok(seen.signal instanceof AbortSignal);
	assert.equal(seen.signal.aborted, false);
	assert.equal(seen.agent, undefined);
	assert.equal(seen.rootCallId, undefined);
});
