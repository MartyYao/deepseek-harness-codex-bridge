import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAuth, getLoginStatus, runCodex, startDeviceLogin, stripAnsi } from "../src/auth.js";

/** spawn double: records calls, drives the child via `behavior`. */
function fakeSpawn(behavior) {
	const calls = [];
	const spawnImpl = (bin, args, options) => {
		calls.push({ bin, args, options });
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdout.destroy = () => {};
		child.stderr.destroy = () => {};
		child.kill = () => { child.killed = true; };
		child.unref = () => { child.unrefed = true; };
		queueMicrotask(() => behavior(child));
		return child;
	};
	return { spawnImpl, calls };
}

async function tempHome(t) {
	const dir = await mkdtemp(join(tmpdir(), "codex-bridge-auth-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test("stripAnsi removes SGR color escapes", () => {
	assert.equal(stripAnsi("[94mhttps://x[0m [90mnote[0m"), "https://x note");
	assert.equal(stripAnsi("plain"), "plain");
});

test("getLoginStatus fast path: no auth.json means logged out without spawning", async (t) => {
	const codexHome = await tempHome(t);
	const spawnImpl = () => { throw new Error("must not spawn"); };
	const status = await getLoginStatus({ codexHome, spawnImpl });
	assert.equal(status.loggedIn, false);
	assert.equal(status.text, "未登录——在对话中输入 /codex login");
});

test("getLoginStatus parses `codex login status` output when auth.json exists", async (t) => {
	const codexHome = await tempHome(t);
	await writeFile(join(codexHome, "auth.json"), "{}");
	const { spawnImpl, calls } = fakeSpawn((child) => {
		// Real codex prints the status line on stderr.
		child.stderr.emit("data", "[90mLogged in using ChatGPT[0m\n");
		child.emit("close", 0);
	});
	const status = await getLoginStatus({ codexHome, spawnImpl });
	assert.equal(status.loggedIn, true);
	assert.match(status.text, /^已登录 ChatGPT/);
	assert.match(status.text, /Logged in using ChatGPT/);
	assert.deepEqual(calls[0].args, ["login", "status"]);
	assert.equal(calls[0].options.env.CODEX_HOME, codexHome);
});

test("getLoginStatus treats a stale auth.json (status rejects login) as logged out", async (t) => {
	const codexHome = await tempHome(t);
	await writeFile(join(codexHome, "auth.json"), "{}");
	const { spawnImpl } = fakeSpawn((child) => {
		child.stderr.emit("data", "Not logged in\n");
		child.emit("close", 1);
	});
	const status = await getLoginStatus({ codexHome, spawnImpl });
	assert.equal(status.loggedIn, false);
	assert.match(status.text, /未登录（auth\.json 存在但无效：Not logged in）/);
});

test("runCodex resolves with captured output and exit code", async (t) => {
	const codexHome = await tempHome(t);
	const { spawnImpl } = fakeSpawn((child) => {
		child.stdout.emit("data", "out");
		child.stderr.emit("data", "err");
		child.emit("close", 3);
	});
	const result = await runCodex(["logout"], { codexHome, spawnImpl });
	assert.deepEqual(result, { code: 3, stdout: "out", stderr: "err", timedOut: false });
});

test("runCodex kills the child and reports the timeout", async (t) => {
	const codexHome = await tempHome(t);
	let childRef;
	const { spawnImpl } = fakeSpawn((child) => { childRef = child; });
	const result = await runCodex(["login", "status"], { codexHome, spawnImpl, timeoutMs: 50 });
	assert.equal(result.timedOut, true);
	assert.equal(result.code, null);
	assert.equal(childRef.killed, true);
});

test("runCodex rejects on spawn error", async (t) => {
	const codexHome = await tempHome(t);
	const { spawnImpl } = fakeSpawn((child) => child.emit("error", new Error("spawn codex ENOENT")));
	await assert.rejects(runCodex(["login", "status"], { codexHome, spawnImpl }), /无法执行 codex login status: spawn codex ENOENT/);
});

test("startDeviceLogin resolves with stripped device-code instructions and detaches", async (t) => {
	const codexHome = await tempHome(t);
	let childRef;
	const { spawnImpl, calls } = fakeSpawn((child) => {
		childRef = child;
		child.stdout.emit("data", "Follow these steps to sign in with ChatGPT using device code authorization:\n\n");
		child.stdout.emit("data", "1. Open this link in your browser\n   [94mhttps://auth.openai.com/codex/device[0m\n\n");
		child.stdout.emit("data", "2. Enter this one-time code\n   [94mUYJG-4YCF6[0m\n");
	});
	let settled = 0;
	const { text } = await startDeviceLogin({ codexHome, spawnImpl, onSettled: () => { settled++; } });
	assert.match(text, /https:\/\/auth\.openai\.com\/codex\/device/);
	assert.match(text, /UYJG-4YCF6/);
	assert.ok(!text.includes("["), "ANSI escapes stripped");
	assert.deepEqual(calls[0].args, ["login", "--device-auth"]);
	assert.equal(childRef.unrefed, true);
	childRef.emit("exit", 0);
	assert.equal(settled, 1, "onSettled fires when the login child exits");
});

test("startDeviceLogin rejects when codex exits before printing the code", async (t) => {
	const codexHome = await tempHome(t);
	const { spawnImpl } = fakeSpawn((child) => {
		child.stderr.emit("data", "Error loading configuration\n");
		child.emit("exit", 1);
	});
	await assert.rejects(startDeviceLogin({ codexHome, spawnImpl }), /codex login 提前退出：\nError loading configuration/);
});

test("startDeviceLogin rejects when the device code never appears", async (t) => {
	const codexHome = await tempHome(t);
	let childRef;
	const { spawnImpl } = fakeSpawn((child) => { childRef = child; });
	await assert.rejects(startDeviceLogin({ codexHome, spawnImpl, captureMs: 50 }), /等待设备码输出超时/);
	assert.equal(childRef.killed, true);
});

test("createAuth bundles the helpers over one CODEX_HOME", async (t) => {
	const codexHome = await tempHome(t);
	const spawnImpl = () => { throw new Error("must not spawn"); };
	const auth = createAuth({ codexHome, bin: "codex-test-bin", spawnImpl });
	assert.equal(auth.codexHome, codexHome);
	assert.equal(auth.bin, "codex-test-bin");
	const status = await auth.getLoginStatus();
	assert.equal(status.loggedIn, false);
});

test("real codex CLI: `login status` against an empty CODEX_HOME reports logged out", async (t) => {
	// Real-binary smoke (acceptance path): no mock, but no auth.json either,
	// so this stays on the fast path and never spawns.
	const codexHome = await tempHome(t);
	const status = await getLoginStatus({ codexHome });
	assert.equal(status.loggedIn, false);
	assert.match(status.text, /未登录/);
});
