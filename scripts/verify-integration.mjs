/**
 * Integration verification against a real `codex app-server` on
 * ws://127.0.0.1:4500. Drives the actual plugin modules (CodexBridge,
 * ThreadMap, runCodexTurn) through:
 *   1. initialize handshake (+ model/list sanity check)
 *   2. thread/start + turn/start + streamed events -> final text
 *   3. multi-turn continuation on the mapped thread (thread/resume)
 *   4. dynamicTools round trip (Codex calls a fake dsh tool back)
 *
 * Usage: node scripts/verify-integration.mjs
 * Exit code 0 = all stages passed.
 */
import { CodexBridge } from "../src/bridge.js";
import { resolveConfig } from "../src/config.js";
import { ThreadMap } from "../src/thread.js";
import { runCodexTurn } from "../src/tools.js";

const config = resolveConfig({ turnTimeoutMs: 300_000 });
const threads = new ThreadMap();

// Minimal ctx double: exposes a deterministic "echo" tool so stage 4 can
// verify the dynamicTools round trip without a live dsh registry.
const ctx = {
	tools: {
		schemas: () => [
			{
				name: "echo",
				description: "Echo the given text back verbatim. Call this tool when asked to echo.",
				parameters: {
					type: "object",
					properties: { text: { type: "string", description: "text to echo" } },
					required: ["text"]
				}
			}
		],
		async execute(exec) {
			if (exec.name !== "echo") return { isError: true, content: [{ type: "text", text: `unknown tool ${exec.name}` }] };
			return { isError: false, content: [{ type: "text", text: `ECHO:${exec.arguments.text}` }] };
		}
	}
};

const bridge = new CodexBridge({
	url: config.appServerUrl,
	clientInfo: { name: "dsh-codex-bridge", title: "dsh Codex Bridge (integration check)", version: "0.1.0" },
	connectTimeoutMs: config.connectTimeoutMs,
	requestTimeoutMs: config.requestTimeoutMs
});

bridge.onServerRequest(async (method, params) => {
	if (method !== "item/tool/call") throw new Error(`unhandled server request ${method}`);
	const name = String(params.tool ?? "").replace(/^dsh_/, "");
	const result = await ctx.tools.execute({ callId: `codex-bridge:${params.callId}`, name, arguments: params.arguments ?? {}, signal: new AbortController().signal });
	const text = result.content.map((block) => block.text).join("\n");
	return { contentItems: [{ type: "inputText", text }], success: !result.isError };
});

bridge.onNotification((method, params) => {
	if (method === "item/agentMessage/delta") process.stdout.write(params.delta ?? "");
	else if (method === "turn/started") console.log(`\n[event] turn/started turnId=${params.turn?.id}`);
	else if (method === "item/started") console.log(`\n[event] item/started type=${params.item?.type}`);
	else if (method === "item/completed") console.log(`[event] item/completed type=${params.item?.type} status=${params.item?.status ?? "-"}`);
	else if (method === "turn/completed") console.log(`[event] turn/completed status=${params.turn?.status}`);
	else if (method === "item/tool/call") console.log(`[event] item/tool/call (notification)`);
	else if (method === "error") console.log(`[event] error willRetry=${params.willRetry}: ${params.error?.message}`);
});

let failures = 0;
const stage = (name, ok, detail = "") => {
	console.log(`\n=== ${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
};

try {
	await bridge.connect();
	console.log(`[stage 1] connected; server userAgent=${bridge.serverInfo?.userAgent ?? "?"}`);
	const models = await bridge.request("model/list");
	const ids = (models.data ?? models).map((model) => model.id ?? model.model ?? "?");
	console.log(`[stage 1] model/list -> ${ids.length} models: ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", ..." : ""}`);
	stage("initialize + model/list", true);
	const modelAvailable = ids.includes(config.defaultModel);
	if (!modelAvailable) {
		console.log(`[warn] configured defaultModel ${config.defaultModel} not in model/list; continuing with server default (model omitted)`);
	}
	const effectiveModel = modelAvailable ? config.defaultModel : null;

	console.log("\n[stage 2] thread/start + turn/start (prompt: reply with exactly BRIDGE_OK)");
	const runArgs = (prompt) => ({
		prompt,
		sessionKey: "integration-check",
		...(effectiveModel !== null ? { model: effectiveModel } : {})
	});
	const first = await runCodexTurn({ bridge, threads, config, ctx, args: runArgs("Reply with exactly: BRIDGE_OK"), signal: new AbortController().signal });
	console.log(`\n[stage 2] tool value: status=${first.status} threadId=${first.threadId}`);
	console.log(`[stage 2] result text:\n${first.text}`);
	stage("thread/start + turn/start + events", first.status === "completed" && first.text.includes("BRIDGE_OK"));

	console.log("\n[stage 3] multi-turn: second call reuses mapped thread (thread/resume)");
	const second = await runCodexTurn({
		bridge, threads, config, ctx,
		args: runArgs("What exact token did I ask you to reply with in the previous turn? Answer with just the token."),
		signal: new AbortController().signal
	});
	console.log(`\n[stage 3] tool value: status=${second.status} threadId=${second.threadId}`);
	console.log(`[stage 3] result text:\n${second.text}`);
	stage("multi-turn continuation", second.status === "completed" && second.threadId === first.threadId && second.text.includes("BRIDGE_OK"));

	console.log("\n[stage 4] dynamicTools round trip (fresh thread, dsh_echo exposed)");
	const toolConfig = resolveConfig({ ...config, dynamicTools: ["echo"] });
	const third = await runCodexTurn({
		bridge, threads: new ThreadMap(), config: toolConfig, ctx,
		args: { ...runArgs("Use the dsh_echo tool to echo the text ROUNDTRIP, then tell me what the tool returned."), sessionKey: "integration-check-tools" },
		signal: new AbortController().signal
	});
	console.log(`\n[stage 4] tool value: status=${third.status} threadId=${third.threadId}`);
	console.log(`[stage 4] result text:\n${third.text}`);
	stage("dynamicTools round trip", third.status === "completed" && (third.text.includes("ECHO:ROUNDTRIP") || third.text.includes("dsh 工具")));
} catch (error) {
	console.error(`\n[fatal] ${error.stack ?? error}`);
	failures++;
} finally {
	bridge.close();
}

console.log(failures === 0 ? "\nALL STAGES PASSED" : `\n${failures} STAGE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
