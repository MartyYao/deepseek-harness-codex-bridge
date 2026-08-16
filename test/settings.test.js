import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.js";
import { SETTINGS_KEYS, SETTINGS_NS, SettingsSchema, registerSettings } from "../src/settings.js";
import { mockSettings, stubAuth } from "./helpers/mock-services.js";

function fakeBridge() {
	const calls = [];
	return {
		calls,
		updateOptions(options) {
			calls.push(options);
			Object.assign(this, {
				url: options.url ?? this.url,
				idleTimeoutMs: options.idleTimeoutMs ?? this.idleTimeoutMs
			});
		},
		url: DEFAULT_CONFIG.appServerUrl,
		idleTimeoutMs: DEFAULT_CONFIG.idleTimeoutMs
	};
}

function setup({ rawConfig = {}, auth } = {}) {
	const settings = mockSettings();
	const ctx = { settings, on() {} };
	const config = resolveConfig(rawConfig);
	const bridge = fakeBridge();
	const result = registerSettings(ctx, { config, bridge, rawConfig, auth: auth ?? stubAuth() });
	return { settings, config, bridge, ...result };
}

test("registers the dsh-codex-bridge namespace with live applies", () => {
	const { settings } = setup();
	assert.equal(settings.state.registrations.length, 1);
	const { ns, options } = settings.state.registrations[0];
	assert.equal(ns, SETTINGS_NS);
	assert.equal(options.applies, "live");
});

test("cordis.patch.yml config becomes the settings base layer (settings keys only)", () => {
	const { settings } = setup({
		rawConfig: { defaultModel: "gpt-5.5", sandbox: "workspace-write", toolPrefix: "x_", turnTimeoutMs: 1234 }
	});
	const { base } = settings.state.registrations[0].options;
	assert.equal(base.defaultModel, "gpt-5.5");
	assert.equal(base.sandbox, "workspace-write");
	// Non-settings keys never enter the base layer.
	assert.ok(!("toolPrefix" in base));
	assert.ok(!("turnTimeoutMs" in base));
	// Every base key is a settings key.
	for (const key of Object.keys(base)) assert.ok(SETTINGS_KEYS.includes(key));
});

test("initial resolved value is applied to the live config and bridge", () => {
	const { config, bridge } = setup({ rawConfig: { defaultModel: "gpt-5.5", idleTimeoutMs: 5_000 } });
	assert.equal(config.defaultModel, "gpt-5.5");
	assert.equal(config.idleTimeoutMs, 5_000);
	assert.equal(bridge.url, DEFAULT_CONFIG.appServerUrl);
	assert.equal(bridge.idleTimeoutMs, 5_000);
	assert.ok(bridge.calls.length >= 1, "updateOptions called");
});

test("watch hot-applies committed settings changes", async () => {
	const { settings, config, bridge } = setup();
	await settings.commit(SettingsSchema, { defaultModel: "gpt-5.6", dynamicTools: ["bash"], appServerUrl: "ws://127.0.0.1:9999" });
	assert.equal(config.defaultModel, "gpt-5.6");
	assert.deepEqual(config.dynamicTools, ["bash"]);
	assert.equal(config.appServerUrl, "ws://127.0.0.1:9999");
	assert.equal(bridge.url, "ws://127.0.0.1:9999");
	// Unrelated config fields stay intact.
	assert.equal(config.toolPrefix, DEFAULT_CONFIG.toolPrefix);
});

test("refreshLoginStatus writes the display field through scope.update", async () => {
	const auth = stubAuth({ getLoginStatus: async () => ({ loggedIn: true, text: "已登录 ChatGPT" }) });
	const { settings, refreshLoginStatus } = setup({ auth });
	await refreshLoginStatus();
	const loginUpdates = settings.state.updates.filter((patch) => "loginStatus" in patch);
	assert.ok(loginUpdates.length >= 1);
	assert.equal(settings.state.value.loginStatus, "已登录 ChatGPT");
});

test("refreshLoginStatus skips the write when the status text is unchanged", async () => {
	const auth = stubAuth({ getLoginStatus: async () => ({ loggedIn: false, text: "未登录" }) });
	const { settings, refreshLoginStatus } = setup({ auth });
	// "未登录" is the schema default: no update should be persisted.
	await refreshLoginStatus();
	assert.equal(settings.state.updates.length, 0);
});

test("a failing status probe never breaks registration", async () => {
	const auth = stubAuth({ getLoginStatus: async () => { throw new Error("probe boom"); } });
	const { refreshLoginStatus } = setup({ auth });
	await assert.doesNotReject(refreshLoginStatus);
});

test("SettingsSchema resolves defaults for an empty section", () => {
	const value = SettingsSchema({});
	assert.equal(value.defaultModel, DEFAULT_CONFIG.defaultModel);
	assert.equal(value.sandbox, DEFAULT_CONFIG.sandbox);
	assert.equal(value.approvalPolicy, DEFAULT_CONFIG.approvalPolicy);
	assert.deepEqual(value.dynamicTools, []);
	assert.equal(value.idleTimeoutMs, DEFAULT_CONFIG.idleTimeoutMs);
	assert.equal(value.appServerUrl, DEFAULT_CONFIG.appServerUrl);
	assert.equal(value.loginStatus, "未登录");
});
