/**
 * codex CLI login helpers: run `codex login`/`logout`/`login status` against
 * the bridge-dedicated CODEX_HOME (~/.codex-bridge) and start the device-code
 * OAuth flow as a child process.
 *
 * The bridge isolates ChatGPT credentials in their own CODEX_HOME so plugin
 * login/logout never touches the user's primary `~/.codex` state. All child
 * processes go through an injectable `spawnImpl` so tests never spawn for real.
 * @module dsh-codex-bridge/auth
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Bridge-dedicated CODEX_HOME: auth.json for plugin-managed login lives here. */
export const DEFAULT_CODEX_HOME = join(homedir(), ".codex-bridge");

/** Strip ANSI SGR escapes so CLI output renders plainly in dsh surfaces. */
export function stripAnsi(text) {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\[[0-9;]*m/g, "");
}

/**
 * Run one codex CLI invocation to completion.
 * @param {string[]} args - e.g. ["login", "status"].
 * @param {object} options
 * @param {string} options.codexHome - CODEX_HOME for the child (created if absent).
 * @param {string} [options.bin] - codex binary name/path (PATH lookup).
 * @param {number} [options.timeoutMs] - kill the child after this budget.
 * @param {typeof spawn} [options.spawnImpl] - injectable for tests.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export async function runCodex(args, { codexHome, bin = "codex", timeoutMs = 15_000, spawnImpl = spawn }) {
	await mkdir(codexHome, { recursive: true });
	return new Promise((resolve, reject) => {
		const child = spawnImpl(bin, args, {
			env: { ...process.env, CODEX_HOME: codexHome },
			stdio: ["ignore", "pipe", "pipe"]
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (code, timedOut) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		};
		const timer = setTimeout(() => {
			try { child.kill(); } catch { /* already gone */ }
			finish(null, true);
		}, timeoutMs);
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`无法执行 ${bin} ${args.join(" ")}: ${error.message}`));
		});
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("close", (code) => finish(code, false));
	});
}

/**
 * Read the current login state: auth.json presence first (cheap, no spawn),
 * then `codex login status` as the authority.
 * @returns {Promise<{loggedIn: boolean, text: string}>} `text` is the
 *   user-facing status line shown in the settings page and /codex status.
 */
export async function getLoginStatus({ codexHome = DEFAULT_CODEX_HOME, bin = "codex", spawnImpl = spawn } = {}) {
	const authJson = join(codexHome, "auth.json");
	if (!existsSync(authJson)) {
		return { loggedIn: false, text: "未登录——在对话中输入 /codex login" };
	}
	try {
		const result = await runCodex(["login", "status"], { codexHome, bin, spawnImpl });
		// codex prints the status line to stderr ("Logged in using ChatGPT",
		// exit 0; "Not logged in", exit 1) — judge the combined output.
		const line = stripAnsi(`${result.stdout}\n${result.stderr}`).split("\n").map((row) => row.trim()).find((row) => row.length > 0) ?? "";
		if (!result.timedOut && result.code === 0 && /logged in/i.test(line)) {
			// "Logged in using ChatGPT" -> "已登录 ChatGPT（codex login status: ...）"
			const method = line.replace(/^logged in using\s+/i, "").trim() || "ChatGPT";
			return { loggedIn: true, text: `已登录 ${method}（codex login status: ${line}）` };
		}
		return { loggedIn: false, text: `未登录（auth.json 存在但无效：${line || "status 查询失败"}）——输入 /codex login 重新登录` };
	} catch (error) {
		return { loggedIn: false, text: `登录状态未知：${error.message}` };
	}
}

/**
 * Start the device-code OAuth flow (`codex login --device-auth`). The child
 * prints the verification URL + one-time code and then keeps polling; this
 * resolves as soon as that guidance has been captured. The child is then
 * unref'd with its stdio destroyed so it never holds the dsh process alive —
 * login completes even if dsh restarts in between.
 * @param {object} options
 * @param {string} [options.codexHome]
 * @param {string} [options.bin]
 * @param {number} [options.captureMs] - budget for the URL+code to appear.
 * @param {typeof spawn} [options.spawnImpl]
 * @param {() => void} [options.onSettled] - fired when the login child exits
 *   (used to refresh the loginStatus display).
 * @returns {Promise<{text: string}>} ANSI-stripped device-code instructions.
 */
export async function startDeviceLogin({ codexHome = DEFAULT_CODEX_HOME, bin = "codex", captureMs = 20_000, spawnImpl = spawn, onSettled } = {}) {
	await mkdir(codexHome, { recursive: true });
	return new Promise((resolve, reject) => {
		const child = spawnImpl(bin, ["login", "--device-auth"], {
			env: { ...process.env, CODEX_HOME: codexHome },
			stdio: ["ignore", "pipe", "pipe"]
		});
		let output = "";
		let captured = false;
		const detach = () => {
			// Release the event loop: pipes are destroyed, the child is unref'd.
			// The codex login process keeps polling on its own and writes
			// auth.json on completion; `exit` still fires if dsh stays alive.
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
		};
		const captureTimer = setTimeout(() => {
			if (captured) return;
			captured = true;
			try { child.kill(); } catch { /* already gone */ }
			detach();
			const seen = stripAnsi(output).trim();
			reject(new Error(`等待设备码输出超时（${captureMs}ms）${seen ? `；已收到：\n${seen}` : "，codex 未产生任何输出"}`));
		}, captureMs);
		const onData = (chunk) => {
			output += chunk;
			if (captured) return;
			const plain = stripAnsi(output);
			// The guidance block ends once both the URL and the one-time code
			// (XXXX-XXXXXX) have been printed.
			if (/https:\/\/auth\.openai\.com\/codex\/device/.test(plain) && /[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/.test(plain)) {
				captured = true;
				clearTimeout(captureTimer);
				detach();
				resolve({ text: plain.trim() });
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", (error) => {
			if (captured) return;
			captured = true;
			clearTimeout(captureTimer);
			reject(new Error(`无法启动 codex login: ${error.message}`));
		});
		child.on("exit", () => {
			if (!captured) {
				captured = true;
				clearTimeout(captureTimer);
				const seen = stripAnsi(output).trim();
				reject(new Error(`codex login 提前退出${seen ? `：\n${seen}` : "（无输出）"}`));
				return;
			}
			onSettled?.();
		});
	});
}

/** Factory bundling the login helpers over one CODEX_HOME / binary / spawn. */
export function createAuth({ codexHome = DEFAULT_CODEX_HOME, bin = "codex", spawnImpl = spawn } = {}) {
	return {
		codexHome,
		bin,
		getLoginStatus: () => getLoginStatus({ codexHome, bin, spawnImpl }),
		startDeviceLogin: ({ onSettled } = {}) => startDeviceLogin({ codexHome, bin, spawnImpl, onSettled }),
		logout: () => runCodex(["logout"], { codexHome, bin, spawnImpl })
	};
}
