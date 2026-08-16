/**
 * The `codex` dsh tool definition, dynamicTools translation, and the mapping
 * of Codex dynamic-tool calls back into the dsh tool registry.
 * @module dsh-codex-bridge/tools
 */
import { TurnCollector } from "./events.js";

/** dsh tool name that must never be exposed back to Codex (recursion guard). */
const SELF_TOOL_NAME = "codex";

/**
 * Marker appended to every dispatched dynamicTool result: the call crossed
 * from Codex into the dsh registry without a human approval step (the bridge
 * runs with `approvalPolicy: never`; approval-dependent tools fail closed).
 */
const UNAPPROVED_NOTE = "[dsh-codex-bridge: 此工具调用由 Codex dynamicTools 发起，未经过 dsh 人工审批]";

/** Responses API tool-name constraint. */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Translate whitelisted dsh tool schemas into codex dynamicTools specs.
 * Names are prefixed to avoid colliding with Codex reserved namespaces, the
 * bridge's own `codex` tool is always excluded, and names violating the
 * Responses API constraint are dropped.
 * @param {Array<{name: string, description?: string, parameters?: object}>} schemas - `ctx.tools.schemas()`.
 * @param {string[]} whitelist - dsh tool names to expose.
 * @param {string} prefix - name prefix, e.g. "dsh_".
 * @returns {Array<object>} DynamicToolSpec entries (function kind).
 */
export function translateDynamicTools(schemas, whitelist, prefix) {
	const allowed = new Set(whitelist);
	const specs = [];
	for (const schema of schemas) {
		if (!allowed.has(schema.name) || schema.name === SELF_TOOL_NAME) continue;
		const name = prefix + schema.name;
		if (!TOOL_NAME_PATTERN.test(name)) continue;
		specs.push({
			type: "function",
			name,
			description: schema.description ?? "",
			inputSchema: schema.parameters ?? { type: "object" }
		});
	}
	return specs;
}

/**
 * Execute one Codex dynamic-tool call against the dsh tool registry.
 * @param {object} ctx - cordis context (needs `tools`).
 * @param {object} call
 * @param {string} call.tool - Codex-side (prefixed) tool name.
 * @param {any} call.args - decoded tool arguments.
 * @param {string} call.prefix - configured prefix.
 * @param {string[]} call.whitelist - configured dsh tool whitelist.
 * @param {string} call.callId - codex callId, reused for dsh-side correlation.
 * @param {object} [call.agent] - calling dsh agent, forwarded to `ctx.tools.execute`.
 * @param {string} [call.rootCallId] - root call of the enclosing codex tool execution.
 * @param {AbortSignal} [call.signal] - aborts when the owning codex turn ends.
 * @returns {Promise<{success: boolean, text: string}>}
 */
export async function executeDshTool(ctx, { tool, args, prefix, whitelist, callId, agent, rootCallId, signal }) {
	const name = tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;
	// Fail closed on self-recursion even if a user whitelists the name: Codex
	// calling the bridge's own codex tool would recurse through the bridge.
	if (name === SELF_TOOL_NAME) {
		return { success: false, text: `tool ${name} is the bridge's own codex tool; recursive invocation is forbidden` };
	}
	if (!whitelist.includes(name)) {
		return { success: false, text: `tool ${name} is not in the dsh-codex-bridge dynamicTools whitelist` };
	}
	let parsedArgs = args;
	if (typeof parsedArgs === "string") {
		try {
			parsedArgs = JSON.parse(parsedArgs);
		} catch {
			return { success: false, text: `invalid arguments for ${name}: not valid JSON` };
		}
	}
	try {
		const result = await ctx.tools.execute({
			callId: `dsh-codex-bridge:${callId}`,
			...(rootCallId !== undefined ? { rootCallId } : {}),
			name,
			arguments: parsedArgs ?? {},
			...(agent !== undefined ? { agent } : {}),
			signal: signal ?? new AbortController().signal
		});
		return { success: !result.isError, text: `${renderContentBlocks(result.content)}\n\n${UNAPPROVED_NOTE}` };
	} catch (error) {
		return { success: false, text: `dsh tool ${name} failed to dispatch: ${error?.message ?? String(error)}` };
	}
}

/** Flatten dsh content blocks into one text payload for the codex side. */
function renderContentBlocks(content) {
	if (!Array.isArray(content)) return String(content ?? "");
	return content
		.map((block) => {
			if (block !== null && typeof block === "object" && typeof block.text === "string") return block.text;
			return JSON.stringify(block);
		})
		.join("\n");
}

/**
 * Run one codex turn end to end: connect, start/resume the thread, start the
 * turn, collect events until completion.
 * @param {object} deps
 * @param {import("./bridge.js").CodexBridge} deps.bridge
 * @param {import("./thread.js").ThreadMap} deps.threads
 * @param {object} deps.config - resolved plugin config.
 * @param {object} deps.ctx - cordis context (for dynamicTools translation).
 * @param {{prompt: string, model?: string, sandbox?: string, thread_id?: string}} deps.args
 * @param {AbortSignal} deps.signal - dsh tool-call cancellation.
 * @param {Map<string, {agent?: object, rootCallId?: string, signal: AbortSignal}>} [deps.activeTurns]
 *   - live turn contexts keyed by codex threadId; lets `item/tool/call`
 *     handlers execute dsh tools with the caller's identity and lifetime.
 * @param {{agent?: object, rootCallId?: string}} [deps.callContext] - the dsh-side caller identity.
 * @returns {Promise<{text: string, threadId: string, status: string}>} canonical tool value.
 */
export async function runCodexTurn({ bridge, threads, config, ctx, args, signal, activeTurns, callContext }) {
	const sessionKey = args.sessionKey;
	try {
		await bridge.connect();
	} catch (error) {
		throw new Error(
			`codex bridge: 无法连接 app-server (${config.appServerUrl}): ${error.message}。` +
			"请确认 `codex app-server --listen` 进程在运行（见插件 README 的 launchd 配置）。"
		);
	}

	const model = args.model ?? config.defaultModel;
	const sandbox = args.sandbox ?? config.sandbox;
	// 以调用者的 agent scope 翻译 dynamicTools：web 模式下 agent 工具
	// （bash/read/write/...）注册在 preset/agent 层，全局视图（不带 scope）
	// 看不到它们，导致 dynamicTools 白名单翻译为空、Codex 侧收不到 dsh_ 工具。
	const dynamicSpecs = translateDynamicTools(ctx.tools.schemas(callContext?.agent), config.dynamicTools, config.toolPrefix);

	let threadId = args.thread_id ?? threads.get(sessionKey);
	let resumedNotice = null;
	if (threadId !== undefined && threadId !== null) {
		try {
			await bridge.request("thread/resume", {
				threadId,
				model,
				sandbox,
				approvalPolicy: config.approvalPolicy
			});
		} catch (error) {
			// Stale mapping (server restart, archived thread): fall back to a fresh thread.
			threads.delete(sessionKey);
			resumedNotice = `（续接 thread ${threadId} 失败：${error.message}；已开启新会话）`;
			threadId = null;
		}
	}
	if (threadId === undefined || threadId === null) {
		const params = {
			model,
			sandbox,
			approvalPolicy: config.approvalPolicy,
			...(config.cwd !== null ? { cwd: config.cwd } : {}),
			...(dynamicSpecs.length > 0 ? { dynamicTools: dynamicSpecs } : {})
		};
		const started = await bridge.request("thread/start", params);
		threadId = started.thread.id;
	}
	threads.set(sessionKey, threadId);

	// Publish this turn's dsh-side call context so dynamicTool calls
	// (`item/tool/call`, keyed by threadId) run with the caller's agent
	// identity and a signal that aborts when the turn ends for any reason
	// (completion, failure, timeout, dsh-side cancel, or disconnect).
	const toolAbort = new AbortController();
	const propagateAbort = () => toolAbort.abort();
	if (signal.aborted) toolAbort.abort();
	else signal.addEventListener("abort", propagateAbort);
	activeTurns?.set(threadId, { agent: callContext?.agent, rootCallId: callContext?.rootCallId, signal: toolAbort.signal });

	const collector = new TurnCollector({
		threadId,
		maxCommandOutputChars: config.maxCommandOutputChars,
		maxProcessChars: config.maxProcessChars
	});
	const offNotification = bridge.onNotification((method, params) => collector.handle(method, params));
	try {
		const started = await bridge.request("turn/start", {
			threadId,
			input: [{ type: "text", text: args.prompt }]
		});
		const turnId = started.turn.id;
		const outcome = await waitForTurn({ bridge, collector, threadId, turnId, signal, turnTimeoutMs: config.turnTimeoutMs });
		if (outcome.status === "completed") {
			const text = collector.renderText();
			const suffix = `\n\n[codex thread_id: ${threadId}${resumedNotice !== null ? ` ${resumedNotice}` : ""}]`;
			return { text: text + suffix, threadId, status: "completed" };
		}
		if (outcome.status === "interrupted") {
			throw new Error(`codex turn 被中断${outcome.error !== null ? `: ${outcome.error}` : ""}`);
		}
		throw new Error(`codex turn failed: ${outcome.error ?? "unknown error"}`);
	} finally {
		offNotification();
		activeTurns?.delete(threadId);
		toolAbort.abort();
		signal.removeEventListener("abort", propagateAbort);
	}
}

/**
 * Await the terminal turn outcome, racing the turn timeout, dsh-side
 * cancellation (both send turn/interrupt on a best-effort basis), and
 * connection teardown (which makes any terminal event impossible).
 */
function waitForTurn({ bridge, collector, threadId, turnId, signal, turnTimeoutMs }) {
	return new Promise((resolve, reject) => {
		const interrupt = () => {
			bridge.request("turn/interrupt", { threadId, turnId }).catch(() => {});
		};
		const timer = setTimeout(() => {
			// Keep the server-side turn from running on after we gave up.
			interrupt();
			cleanup();
			reject(new Error(`codex turn 超时（${turnTimeoutMs}ms 内未收到 turn/completed，已请求 turn/interrupt）`));
		}, turnTimeoutMs);
		const onAbort = () => {
			interrupt();
			cleanup();
			reject(new Error("codex 工具调用被 dsh 侧取消（已请求 turn/interrupt）"));
		};
		const offClose = bridge.onClose(() => {
			cleanup();
			reject(new Error("codex bridge: 与 app-server 的连接已关闭，turn 未收到终态"));
		});
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			offClose();
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort);
		collector.done.then((outcome) => {
			cleanup();
			resolve(outcome);
		});
	});
}
