/**
 * dsh-codex-bridge — let dsh agents run tasks through the official Codex
 * (ChatGPT subscription) via a local `codex app-server` process.
 *
 * Cordis plugin shape: named exports `name` / `inject` / `Config` / `apply`,
 * following the dsh tool-plugin convention (dsh-tool-bash, dsh-memory-map).
 * @module dsh-codex-bridge
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createAuth } from "./auth.js";
import { CodexBridge } from "./bridge.js";
import { registerCommands } from "./commands.js";
import { APPROVAL_POLICIES, DEFAULT_CONFIG, SANDBOX_MODES, resolveConfig } from "./config.js";
import { registerSettings } from "./settings.js";
import { ThreadMap } from "./thread.js";
import { executeDshTool, runCodexTurn } from "./tools.js";

export const name = "dsh-codex-bridge";

/** Tool registry, settings surface (settings UI), and the /codex command. */
export const inject = ["tools", "settings", "commands"];

/** Cordis-facing config schema (applies defaults; resolveConfig re-validates). */
export const Config = z.object({
	appServerUrl: z.string().default(DEFAULT_CONFIG.appServerUrl),
	defaultModel: z.string().default(DEFAULT_CONFIG.defaultModel),
	sandbox: z.union(SANDBOX_MODES.map((mode) => z.const(mode))).default(DEFAULT_CONFIG.sandbox),
	approvalPolicy: z.union(APPROVAL_POLICIES.map((policy) => z.const(policy))).default(DEFAULT_CONFIG.approvalPolicy),
	// schemastery treats a null .default() as no fallback: absence surfaces as
	// undefined and apply() normalizes undefined/"" to null (app-server
	// semantics: null/omitted = server default cwd).
	cwd: z.union([z.string(), z.const(null)]),
	dynamicTools: z.array(z.string()).default([]),
	toolPrefix: z.string().default(DEFAULT_CONFIG.toolPrefix),
	connectTimeoutMs: z.number().default(DEFAULT_CONFIG.connectTimeoutMs),
	requestTimeoutMs: z.number().default(DEFAULT_CONFIG.requestTimeoutMs),
	idleTimeoutMs: z.number().default(DEFAULT_CONFIG.idleTimeoutMs),
	turnTimeoutMs: z.number().default(DEFAULT_CONFIG.turnTimeoutMs),
	maxCommandOutputChars: z.number().default(DEFAULT_CONFIG.maxCommandOutputChars),
	maxProcessChars: z.number().default(DEFAULT_CONFIG.maxProcessChars)
});

/** Client identity sent in the initialize handshake. */
const CLIENT_INFO = { name: "dsh-codex-bridge", title: "dsh Codex Bridge", version: "0.1.0" };

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {object} [rawConfig]
 * @param {object} [deps] - test seams; production (cordis) never passes these.
 * @param {object} [deps.auth] - createAuth() bundle override.
 */
export function apply(ctx, rawConfig = {}, deps = {}) {
	// cordis leaves absent optional values at the schema default; normalize the
	// empty-string cwd placeholder (yml configs sometimes carry one) to null.
	const config = resolveConfig({ ...rawConfig, cwd: rawConfig.cwd ? rawConfig.cwd : null });
	const threads = new ThreadMap();
	const bridge = new CodexBridge({
		url: config.appServerUrl,
		clientInfo: CLIENT_INFO,
		connectTimeoutMs: config.connectTimeoutMs,
		requestTimeoutMs: config.requestTimeoutMs,
		idleTimeoutMs: config.idleTimeoutMs
	});
	// Live codex turns keyed by threadId: lets item/tool/call execute dsh
	// tools with the calling agent's identity and the turn's lifetime.
	const activeTurns = new Map();

	// Codex -> dsh tool calls (dynamicTools round trip). Any other server
	// request (approval prompts under a non-"never" policy, elicitations, ...)
	// gets a JSON-RPC error from the bridge itself so the turn never hangs.
	bridge.onServerRequest(async (method, params) => {
		if (method !== "item/tool/call") {
			throw new Error(`dsh-codex-bridge does not handle server request ${method}`);
		}
		const turnContext = activeTurns.get(String(params?.threadId ?? ""));
		const outcome = await executeDshTool(ctx, {
			tool: params?.tool ?? "",
			args: params?.arguments,
			prefix: config.toolPrefix,
			whitelist: config.dynamicTools,
			callId: String(params?.callId ?? "unknown"),
			agent: turnContext?.agent,
			rootCallId: turnContext?.rootCallId,
			signal: turnContext?.signal
		});
		return {
			contentItems: [{ type: "inputText", text: outcome.text }],
			success: outcome.success
		};
	});

	ctx.on("dispose", () => bridge.close());

	// Settings surface: registers the dsh-codex-bridge namespace (rendered as a
	// form in the settings UI), layers cordis.patch.yml config as `base`, and
	// hot-applies committed changes to `config`/`bridge`. The /codex command
	// carries the actions a form cannot express (device-code login/logout).
	const auth = deps.auth ?? createAuth();
	const { refreshLoginStatus } = registerSettings(ctx, { config, bridge, rawConfig, auth });
	registerCommands(ctx, { bridge, config, auth, refreshLoginStatus });

	ctx.tools.register(defineTool({
		name: "codex",
		description:
			"当用户明确要求使用 GPT/ChatGPT/Codex 模型、或任务适合由 Codex 执行时调用。" +
			"执行时间可能较长（秒级到分钟级）。返回 Codex 的最终回复（附过程摘要）。" +
			"多轮可传 thread_id 延续；同一 dsh 会话内不传时会自动续接上一次会话（桥重启后映射丢失，" +
			"此时返回文本中会给出新的 thread_id 供后续显式传入）。",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "交给 Codex 执行的任务描述（完整、自包含；Codex 看不到当前对话上下文）"
			},
			model: {
				type: "string",
				description: "覆盖默认模型（默认取插件配置 defaultModel）"
			},
			sandbox: {
				type: "string",
				enum: SANDBOX_MODES,
				description: "Codex 沙箱模式，默认取插件配置 sandbox"
			},
			thread_id: {
				type: "string",
				description: "续接的 codex 会话 id；不传则沿用本 dsh 会话的上一个 thread，没有则新建"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: { type: "string", required: true },
					threadId: { type: "string", required: true },
					status: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		async execute(args, exec) {
			if (typeof args.prompt !== "string" || args.prompt.trim().length === 0) {
				throw new Error("invalid prompt: expected a non-empty string");
			}
			const sessionKey = exec.agent?.id ?? "default";
			return threads.runSerialized(sessionKey, () =>
				runCodexTurn({
					bridge,
					threads,
					config,
					ctx,
					args: { ...args, sessionKey },
					signal: exec.signal,
					activeTurns,
					callContext: { agent: exec.agent, rootCallId: exec.rootCallId ?? exec.callId }
				})
			);
		}
	}));
}
