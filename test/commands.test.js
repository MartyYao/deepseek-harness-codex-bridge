import assert from "node:assert/strict";
import { test } from "node:test";
import { executeCodexCommand, registerCommands } from "../src/commands.js";
import { resolveConfig } from "../src/config.js";
import { mockCommands, stubAuth } from "./helpers/mock-services.js";

function fakeBridge({ models = [{ id: "gpt-5.6-terra" }, { id: "gpt-5.6" }, { id: "gpt-5.5" }], connectError = null } = {}) {
	return {
		async connect() {
			if (connectError !== null) throw connectError;
		},
		async request(method) {
			assert.equal(method, "model/list");
			return { data: models };
		}
	};
}

function deps(overrides = {}) {
	return {
		bridge: fakeBridge(),
		config: resolveConfig({}),
		auth: stubAuth(),
		refreshLoginStatus: async () => {},
		...overrides
	};
}

const invoke = (rawInput) => ({ rawInput, commandId: "cmd-1", agent: {}, signal: new AbortController().signal });

test("registerCommands registers the codex command with an input hint", () => {
	const commands = mockCommands();
	const ctx = { commands };
	const dispose = registerCommands(ctx, deps());
	assert.equal(commands.definitions.length, 1);
	assert.equal(commands.definitions[0].name, "codex");
	assert.equal(commands.definitions[0].input.hint, "[login|logout|status|models]");
	assert.equal(typeof commands.definitions[0].handler, "function");
	dispose();
	assert.equal(commands.definitions.length, 0);
});

test("/codex and /codex status report the logged-out state", async () => {
	for (const rawInput of ["", "status", "  status  "]) {
		const result = await executeCodexCommand(deps(), invoke(rawInput));
		assert.equal(result.kind, "success");
		assert.match(result.text, /未登录/);
		assert.match(result.text, /\/codex login/);
		assert.match(result.text, /\/tmp\/fake-codex-home/);
	}
});

test("/codex status reports the logged-in state", async () => {
	const auth = stubAuth({ getLoginStatus: async () => ({ loggedIn: true, text: "已登录 ChatGPT（codex login status: Logged in using ChatGPT）" }) });
	const result = await executeCodexCommand(deps({ auth }), invoke("status"));
	assert.equal(result.kind, "success");
	assert.match(result.text, /已登录 ChatGPT/);
	assert.doesNotMatch(result.text, /登录：\/codex login/);
});

test("/codex status refreshes the settings display field", async () => {
	let refreshed = 0;
	const result = await executeCodexCommand(deps({ refreshLoginStatus: async () => { refreshed++; } }), invoke("status"));
	assert.equal(result.kind, "success");
	assert.equal(refreshed, 1);
});

test("/codex login short-circuits when already logged in", async () => {
	let started = 0;
	const auth = stubAuth({
		getLoginStatus: async () => ({ loggedIn: true, text: "已登录 ChatGPT" }),
		startDeviceLogin: async () => { started++; return { text: "" }; }
	});
	const result = await executeCodexCommand(deps({ auth }), invoke("login"));
	assert.equal(result.kind, "success");
	assert.match(result.text, /已处于登录状态/);
	assert.equal(started, 0);
});

test("/codex login returns the device-code instructions", async () => {
	const auth = stubAuth({
		startDeviceLogin: async ({ onSettled }) => {
			assert.equal(typeof onSettled, "function");
			return { text: "1. Open https://auth.openai.com/codex/device\n2. Enter code ABCD-12345" };
		}
	});
	const result = await executeCodexCommand(deps({ auth }), invoke("login"));
	assert.equal(result.kind, "success");
	assert.match(result.text, /设备码登录/);
	assert.match(result.text, /https:\/\/auth\.openai\.com\/codex\/device/);
	assert.match(result.text, /ABCD-12345/);
});

test("/codex login surfaces a flow-start failure as an error result", async () => {
	const auth = stubAuth({ startDeviceLogin: async () => { throw new Error("等待设备码输出超时"); } });
	const result = await executeCodexCommand(deps({ auth }), invoke("login"));
	assert.equal(result.kind, "error");
	assert.match(result.text, /登录流程启动失败：等待设备码输出超时/);
});

test("/codex logout succeeds and refreshes the display", async () => {
	let refreshed = 0;
	const result = await executeCodexCommand(deps({ refreshLoginStatus: async () => { refreshed++; } }), invoke("logout"));
	assert.equal(result.kind, "success");
	assert.match(result.text, /已登出/);
	assert.equal(refreshed, 1);
});

test("/codex logout maps a non-zero exit to an error result", async () => {
	const auth = stubAuth({ logout: async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false }) });
	const result = await executeCodexCommand(deps({ auth }), invoke("logout"));
	assert.equal(result.kind, "error");
	assert.match(result.text, /codex logout 失败（exit 1）：boom/);
});

test("/codex models lists app-server models and marks the default", async () => {
	const result = await executeCodexCommand(deps(), invoke("models"));
	assert.equal(result.kind, "success");
	assert.match(result.text, /3 个/);
	assert.match(result.text, /\* gpt-5\.6-terra（当前默认）/);
	assert.match(result.text, / {2}gpt-5\.5/);
});

test("/codex models reports a connect failure with the app-server hint", async () => {
	const result = await executeCodexCommand(deps({ bridge: fakeBridge({ connectError: new Error("socket error") }) }), invoke("models"));
	assert.equal(result.kind, "error");
	assert.match(result.text, /无法连接 app-server/);
	assert.match(result.text, /ws:\/\/127\.0\.0\.1:4500/);
});

test("unknown subcommand returns the usage error", async () => {
	const result = await executeCodexCommand(deps(), invoke("frobnicate"));
	assert.equal(result.kind, "error");
	assert.match(result.text, /未知子命令「frobnicate」/);
	assert.match(result.text, /\/codex login/);
});
