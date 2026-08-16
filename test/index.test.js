import assert from "node:assert/strict";
import { test } from "node:test";
import { mockCommands, mockSettings, stubAuth } from "./helpers/mock-services.js";

function mockCtx() {
	const tools = [];
	const settings = mockSettings();
	const commands = mockCommands();
	return {
		tools: {
			register(definition) {
				tools.push(definition);
				return () => {};
			},
			schemas: () => []
		},
		settings,
		commands,
		on() {},
		registeredTools: tools
	};
}

test("plugin entry exposes the cordis plugin shape", async () => {
	const plugin = await import("../src/index.js");
	assert.equal(plugin.name, "dsh-codex-bridge");
	assert.deepEqual(plugin.inject, ["tools", "settings", "commands"]);
	assert.equal(typeof plugin.apply, "function");
	assert.ok(plugin.Config !== undefined, "Config schema exported");
});

test("apply registers the codex tool via defineTool", async () => {
	const { apply } = await import("../src/index.js");
	const ctx = mockCtx();
	apply(ctx, {}, { auth: stubAuth() });
	assert.equal(ctx.registeredTools.length, 1);
	const tool = ctx.registeredTools[0];
	assert.equal(tool.name, "codex");
	assert.equal(typeof tool.execute, "function");
	// defineTool compiled the parameter DSL to a raw object JSON schema.
	assert.equal(tool.parameters.type, "object");
	assert.deepEqual(tool.parameters.required, ["prompt"]);
	assert.ok("thread_id" in tool.parameters.properties);
	// Output contract renders the canonical value to one text block.
	const rendered = tool.output.render({}, { text: "done", threadId: "th", status: "completed" });
	assert.deepEqual(rendered, [{ type: "text", text: "done" }]);
});

test("apply registers the settings namespace and the /codex command", async () => {
	const { apply } = await import("../src/index.js");
	const ctx = mockCtx();
	apply(ctx, {}, { auth: stubAuth() });
	assert.equal(ctx.settings.state.registrations.length, 1);
	assert.equal(ctx.settings.state.registrations[0].ns, "dsh-codex-bridge");
	assert.equal(ctx.commands.definitions.length, 1);
	assert.equal(ctx.commands.definitions[0].name, "codex");
});

test("apply rejects invalid config with a clear message", async () => {
	const { apply } = await import("../src/index.js");
	assert.throws(() => apply(mockCtx(), { sandbox: "yolo" }, { auth: stubAuth() }), /sandbox must be one of/);
	assert.throws(() => apply(mockCtx(), { idleTimeoutMs: -1 }, { auth: stubAuth() }), /idleTimeoutMs must be a positive number/);
});

test("Config schema applies the idleTimeoutMs default and accepts overrides", async () => {
	const { Config } = await import("../src/index.js");
	assert.equal(Config({}).idleTimeoutMs, 30_000);
	assert.equal(Config({ idleTimeoutMs: 5_000 }).idleTimeoutMs, 5_000);
});

test("Config schema accepts null and string cwd (app-server semantics: null = default cwd)", async () => {
	const { Config, apply } = await import("../src/index.js");
	// schemastery has no working null default: absence surfaces as undefined,
	// and apply() normalizes undefined/"" to null.
	assert.equal(Config({}).cwd, undefined);
	assert.equal(Config({ cwd: null }).cwd, null);
	assert.equal(Config({ cwd: "/tmp/work" }).cwd, "/tmp/work");
	assert.doesNotThrow(() => apply(mockCtx(), Config({}), { auth: stubAuth() }));
	assert.doesNotThrow(() => apply(mockCtx(), Config({ cwd: null }), { auth: stubAuth() }));
});
