/**
 * Settings-surface integration (`ctx.settings`): registers the
 * `dsh-codex-bridge` namespace so the plugin appears in the dsh settings UI
 * as an auto-rendered form, and hot-applies committed changes to the live
 * bridge/config.
 *
 * Layering: schema defaults < composition `base` (the cordis.patch.yml plugin
 * config) < user document (settings UI writes). Fields absent from the
 * settings schema (cwd, toolPrefix, timeouts, ...) stay config-only.
 * @module dsh-codex-bridge/settings
 */
import z from "@deepseek-ai/schemastery";
import { APPROVAL_POLICIES, DEFAULT_CONFIG, SANDBOX_MODES } from "./config.js";

/** Settings namespace (kebab-case, matches the plugin short name). */
export const SETTINGS_NS = "dsh-codex-bridge";

/**
 * Keys shared between the settings schema and the live bridge config. The
 * cordis.patch.yml values for these keys become the settings `base` layer;
 * everything else in the plugin config is untouched by the settings surface.
 */
export const SETTINGS_KEYS = ["defaultModel", "sandbox", "approvalPolicy", "dynamicTools", "idleTimeoutMs", "appServerUrl"];

/** Settings form schema; `toJSON()` is what the configuration UI renders. */
export const SettingsSchema = z.object({
	defaultModel: z.string()
		.description("默认模型（codex 工具未显式指定 model 时使用），如 gpt-5.6-terra / gpt-5.6 / gpt-5.5；以 /codex models 实际列表为准")
		.default(DEFAULT_CONFIG.defaultModel),
	sandbox: z.union(SANDBOX_MODES.map((mode) => z.const(mode)))
		.description("Codex 沙箱模式")
		.default(DEFAULT_CONFIG.sandbox),
	approvalPolicy: z.union(APPROVAL_POLICIES.map((policy) => z.const(policy)))
		.description("审批策略；桥接场景必须 never（没有人回答审批请求）")
		.default(DEFAULT_CONFIG.approvalPolicy),
	dynamicTools: z.array(z.string())
		.description("暴露给 Codex 调用的 dsh 工具白名单（dsh_ 前缀），空数组 = 关闭")
		.default([]),
	idleTimeoutMs: z.number()
		.description("空闲多久（毫秒）后断开 app-server 连接；下次调用自动重连")
		.default(DEFAULT_CONFIG.idleTimeoutMs),
	appServerUrl: z.string()
		.description("codex app-server 的 WebSocket 地址")
		.default(DEFAULT_CONFIG.appServerUrl),
	// 只读展示字段：登录动作走 /codex login 命令，这里只反映最新状态。
	// 插件加载时与 login/logout 完成后经 scope.update() 刷新。
	loginStatus: z.string()
		.description("ChatGPT 登录状态（只读；登录/登出在对话中用 /codex login、/codex logout）")
		.default("未登录")
});

/**
 * Register the settings namespace and wire hot-apply.
 * @param {object} ctx - cordis context (needs `settings`, `on`).
 * @param {object} deps
 * @param {object} deps.config - the live resolved plugin config; mutated in
 *   place so in-flight closures (runCodexTurn, the server-request handler)
 *   observe committed changes.
 * @param {import("./bridge.js").CodexBridge} deps.bridge
 * @param {object} [deps.rawConfig] - the composition plugin config
 *   (cordis.patch.yml); overlapping keys become the settings `base` layer.
 * @param {{getLoginStatus: () => Promise<{loggedIn: boolean, text: string}>}} deps.auth
 * @returns {{scope: object, refreshLoginStatus: () => Promise<void>}}
 */
export function registerSettings(ctx, { config, bridge, rawConfig = {}, auth }) {
	const base = {};
	for (const key of SETTINGS_KEYS) {
		if (rawConfig[key] !== undefined) base[key] = rawConfig[key];
	}
	// `settingsNamespace` is a runtime no-op brand over kebab-case strings;
	// SETTINGS_NS is already a valid namespace literal.
	const scope = ctx.settings.register(SETTINGS_NS, SettingsSchema, { base, applies: "live" });

	const applyValue = (value) => {
		config.defaultModel = value.defaultModel;
		config.sandbox = value.sandbox;
		config.approvalPolicy = value.approvalPolicy;
		config.dynamicTools = [...value.dynamicTools];
		config.idleTimeoutMs = value.idleTimeoutMs;
		config.appServerUrl = value.appServerUrl;
		bridge.updateOptions({ url: value.appServerUrl, idleTimeoutMs: value.idleTimeoutMs });
	};
	applyValue(scope.get());
	const unwatch = scope.watch((next) => applyValue(next));
	ctx.on("dispose", unwatch);

	// loginStatus is a display snapshot written through the user layer: it is
	// refreshed on every plugin load and after login/logout, so a stale value
	// persisted by an earlier session self-heals on the next dsh start.
	const refreshLoginStatus = async () => {
		try {
			const status = await auth.getLoginStatus();
			if (scope.get().loginStatus !== status.text) await scope.update({ loginStatus: status.text });
		} catch {
			// Display-only field: never let a status refresh break the plugin.
		}
	};
	void refreshLoginStatus();

	return { scope, refreshLoginStatus };
}
