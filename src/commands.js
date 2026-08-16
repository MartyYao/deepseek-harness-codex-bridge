/**
 * The `/codex` human command: GPT login (device-code OAuth), logout, login
 * status, and the app-server model list. Settings UI has no button control,
 * so login lives here as a conversation command.
 * @module dsh-codex-bridge/commands
 */
import { stripAnsi } from "./auth.js";

const USAGE = "用法：/codex login（设备码登录）| /codex logout | /codex status | /codex models";

/**
 * @param {object} deps
 * @param {import("./bridge.js").CodexBridge} deps.bridge - reused for model/list.
 * @param {object} deps.config - live config (marks the default model).
 * @param {object} deps.auth - createAuth() bundle (CODEX_HOME-scoped).
 * @param {() => Promise<void>} deps.refreshLoginStatus - settings display refresh.
 * @param {import("@deepseek-ai/dsh-commands").CommandInvocation} invocation
 * @returns {Promise<import("@deepseek-ai/dsh-commands").CommandResult>}
 */
export async function executeCodexCommand({ bridge, config, auth, refreshLoginStatus }, invocation) {
	const sub = invocation.rawInput.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

	if (sub === "login") {
		const current = await auth.getLoginStatus();
		if (current.loggedIn) {
			return { kind: "success", text: `已处于登录状态：${current.text}\n如需换账号请先 /codex logout` };
		}
		try {
			const { text } = await auth.startDeviceLogin({ onSettled: () => void refreshLoginStatus() });
			return {
				kind: "success",
				text:
					"已启动 ChatGPT 设备码登录（codex login --device-auth）：\n\n" + text +
					"\n\n在浏览器中打开上面的链接并输入一次性代码即可完成登录；" +
					"登录在后台轮询（约 15 分钟内有效），完成后用 /codex status 确认。"
			};
		} catch (error) {
			return { kind: "error", text: `登录流程启动失败：${error.message}` };
		}
	}

	if (sub === "logout") {
		try {
			const result = await auth.logout();
			await refreshLoginStatus();
			const detail = stripAnsi(`${result.stdout}\n${result.stderr}`).trim();
			if (result.timedOut) return { kind: "error", text: "codex logout 执行超时" };
			if (result.code !== 0) return { kind: "error", text: `codex logout 失败（exit ${result.code}）：${detail}` };
			return { kind: "success", text: `已登出 ChatGPT（${auth.codexHome}）${detail ? `\n${detail}` : ""}` };
		} catch (error) {
			return { kind: "error", text: `登出失败：${error.message}` };
		}
	}

	if (sub === "" || sub === "status") {
		try {
			const status = await auth.getLoginStatus();
			await refreshLoginStatus();
			return {
				kind: "success",
				text: `${status.text}\n凭据目录：${auth.codexHome}${status.loggedIn ? "" : "\n登录：/codex login"}`
			};
		} catch (error) {
			return { kind: "error", text: `状态查询失败：${error.message}` };
		}
	}

	if (sub === "models") {
		try {
			await bridge.connect();
		} catch (error) {
			return { kind: "error", text: `无法连接 app-server（${config.appServerUrl}）：${error.message}。请确认 codex app-server 进程在运行。` };
		}
		try {
			const models = await bridge.request("model/list");
			const list = (models.data ?? models).map((model) => model.id ?? model.model ?? "?");
			if (list.length === 0) return { kind: "success", text: "app-server 未返回任何模型" };
			const lines = list.map((id) => (id === config.defaultModel ? `* ${id}（当前默认）` : `  ${id}`));
			return { kind: "success", text: `app-server 可用模型（${list.length} 个，当前默认：${config.defaultModel}）：\n${lines.join("\n")}\n\n切换默认模型：设置页 dsh-codex-bridge → defaultModel` };
		} catch (error) {
			return { kind: "error", text: `model/list 查询失败：${error.message}` };
		}
	}

	return { kind: "error", text: `未知子命令「${sub}」。${USAGE}` };
}

/**
 * Register the `/codex` command. The handler executes without sending
 * anything to the model (per dsh-commands semantics).
 * @param {object} ctx - cordis context (needs `commands`).
 * @param {object} deps - see executeCodexCommand.
 * @returns {() => void} the registration disposer.
 */
export function registerCommands(ctx, deps) {
	return ctx.commands.register({
		name: "codex",
		description: "Codex 桥：ChatGPT 登录 / 登出 / 状态 / 可用模型",
		input: { hint: "[login|logout|status|models]" },
		handler: (invocation) => executeCodexCommand(deps, invocation)
	});
}
