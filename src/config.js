/**
 * Configuration defaults and validation for dsh-codex-bridge.
 *
 * The cordis `Config` schema in index.js applies defaults; `resolveConfig`
 * re-validates so the plugin also fails clearly when driven outside cordis
 * (tests, direct apply() calls).
 * @module dsh-codex-bridge/config
 */

/** Sandbox modes accepted by codex `thread/start` (`SandboxMode`). */
export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];

/** Approval policies accepted by codex (`AskForApproval` simple variants). */
export const APPROVAL_POLICIES = ["untrusted", "on-request", "never"];

/** Default configuration values. */
export const DEFAULT_CONFIG = Object.freeze({
	/** WebSocket endpoint of the local codex app-server. */
	appServerUrl: "ws://127.0.0.1:4500",
	/** Model passed to thread/start when the tool call does not override it. */
	defaultModel: "gpt-5.6-terra",
	/** Sandbox mode for new threads. */
	sandbox: "read-only",
	/**
	 * Approval policy for new threads. `never` is the only mode that cannot
	 * stall a bridge-driven turn: approval server-requests have no human on
	 * the dsh side to answer them.
	 */
	approvalPolicy: "never",
	/** Optional working directory for new threads; omit to use the server default. */
	cwd: null,
	/** Whitelist of dsh tool names exposed to Codex as dynamicTools. Empty = off. */
	dynamicTools: [],
	/** Prefix added to dsh tool names on the Codex side (avoids reserved namespaces). */
	toolPrefix: "dsh_",
	/** WebSocket connect + initialize handshake budget. */
	connectTimeoutMs: 10_000,
	/** Budget for ordinary JSON-RPC requests (thread/start, turn/start, ...). */
	requestTimeoutMs: 30_000,
	/**
	 * Close the app-server connection after this much inactivity. dsh headless
	 * runs never fire the plugin dispose hook, so without this the held socket
	 * keeps the dsh process alive after the task finished. Any later request
	 * reconnects lazily.
	 */
	idleTimeoutMs: 30_000,
	/** Budget for one codex turn, from turn/start to turn/completed. */
	turnTimeoutMs: 900_000,
	/** Per-command captured output cap; the kept tail is what survives. */
	maxCommandOutputChars: 4_000,
	/** Total process-summary cap in the tool result text. */
	maxProcessChars: 8_000
});

/**
 * Merge user config over defaults and validate.
 * @param {object} [raw] - user-supplied plugin config.
 * @returns {object} the effective configuration.
 * @throws {Error} on invalid enum values or malformed fields.
 */
export function resolveConfig(raw = {}) {
	const config = { ...DEFAULT_CONFIG, ...raw };
	if (typeof config.appServerUrl !== "string" || !/^wss?:\/\//.test(config.appServerUrl)) {
		throw new Error(`dsh-codex-bridge config: appServerUrl must be a ws:// or wss:// URL, got ${JSON.stringify(config.appServerUrl)}`);
	}
	if (!SANDBOX_MODES.includes(config.sandbox)) {
		throw new Error(`dsh-codex-bridge config: sandbox must be one of ${SANDBOX_MODES.join(", ")}, got ${JSON.stringify(config.sandbox)}`);
	}
	if (!APPROVAL_POLICIES.includes(config.approvalPolicy)) {
		throw new Error(`dsh-codex-bridge config: approvalPolicy must be one of ${APPROVAL_POLICIES.join(", ")}, got ${JSON.stringify(config.approvalPolicy)}`);
	}
	if (typeof config.defaultModel !== "string" || config.defaultModel.length === 0) {
		throw new Error(`dsh-codex-bridge config: defaultModel must be a non-empty string`);
	}
	if (config.cwd !== null && typeof config.cwd !== "string") {
		throw new Error(`dsh-codex-bridge config: cwd must be a string or null`);
	}
	if (!Array.isArray(config.dynamicTools) || config.dynamicTools.some((name) => typeof name !== "string")) {
		throw new Error(`dsh-codex-bridge config: dynamicTools must be an array of dsh tool names`);
	}
	if (typeof config.toolPrefix !== "string" || !/^[a-zA-Z0-9_-]*$/.test(config.toolPrefix)) {
		throw new Error(`dsh-codex-bridge config: toolPrefix must match [a-zA-Z0-9_-]*, got ${JSON.stringify(config.toolPrefix)}`);
	}
	for (const key of ["connectTimeoutMs", "requestTimeoutMs", "idleTimeoutMs", "turnTimeoutMs", "maxCommandOutputChars", "maxProcessChars"]) {
		if (!Number.isFinite(config[key]) || config[key] <= 0) {
			throw new Error(`dsh-codex-bridge config: ${key} must be a positive number, got ${JSON.stringify(config[key])}`);
		}
	}
	return config;
}
