/**
 * JSON-RPC 2.0 client for the codex app-server WebSocket transport.
 *
 * Wire shape (per codex app-server README): one JSON-RPC message per text
 * frame, the `"jsonrpc": "2.0"` member omitted. Three message kinds:
 * - client request  -> server response matched by `id`
 * - server notification (`method`, no `id`) -> notification listeners
 * - server request (`method` + `id`, e.g. `item/tool/call`) -> server-request
 *   handler, whose return value (or thrown error) becomes the response.
 *
 * Uses the Node >= 22 native WebSocket; an alternate implementation can be
 * injected for tests. No third-party dependencies.
 * @module dsh-codex-bridge/bridge
 */

/** Classified bridge failure. `kind` drives user-facing error text. */
export class BridgeError extends Error {
	/**
	 * @param {'connect'|'timeout'|'rpc'|'closed'|'protocol'} kind
	 * @param {string} message
	 */
	constructor(kind, message, options) {
		super(message, options);
		this.name = "BridgeError";
		this.kind = kind;
	}
}

export class CodexBridge {
	/**
	 * @param {object} options
	 * @param {string} options.url - ws:// endpoint of the app-server.
	 * @param {{name: string, version: string}} options.clientInfo
	 * @param {number} [options.connectTimeoutMs]
	 * @param {number} [options.requestTimeoutMs]
	 * @param {number} [options.idleTimeoutMs] - close the connection after this
	 *   much inactivity (request sent, frame received, server-request answered).
	 *   A non-positive or non-finite value disables the idle close. The next
	 *   `connect()` after an idle close re-establishes the socket lazily.
	 * @param {typeof WebSocket} [options.WebSocketImpl] - injectable for tests.
	 */
	constructor({ url, clientInfo, connectTimeoutMs = 10_000, requestTimeoutMs = 30_000, idleTimeoutMs = 30_000, WebSocketImpl = globalThis.WebSocket }) {
		if (typeof WebSocketImpl !== "function") {
			throw new BridgeError("connect", "no WebSocket implementation available (requires Node >= 22)");
		}
		this.url = url;
		this.clientInfo = clientInfo;
		this.connectTimeoutMs = connectTimeoutMs;
		this.requestTimeoutMs = requestTimeoutMs;
		this.idleTimeoutMs = idleTimeoutMs;
		this._WebSocketImpl = WebSocketImpl;
		this._ws = null;
		this._ready = false;
		this._connecting = null;
		this._nextId = 0;
		this._pending = new Map();
		this._notificationListeners = new Set();
		this._closeListeners = new Set();
		this._serverRequestHandler = null;
		this._idleTimer = null;
		/** Result of the initialize handshake (userAgent, codexHome, ...). */
		this.serverInfo = null;
	}

	/** Whether the socket is open and the initialize handshake completed. */
	get connected() {
		return this._ready;
	}

	/**
	 * Hot-apply changed options (settings-surface writes). A URL change drops
	 * the current connection (if any) so the next `connect()` dials the new
	 * endpoint; timeout changes apply to subsequent activity.
	 */
	updateOptions({ url, connectTimeoutMs, requestTimeoutMs, idleTimeoutMs } = {}) {
		const urlChanged = url !== undefined && url !== this.url;
		if (url !== undefined) this.url = url;
		if (connectTimeoutMs !== undefined) this.connectTimeoutMs = connectTimeoutMs;
		if (requestTimeoutMs !== undefined) this.requestTimeoutMs = requestTimeoutMs;
		if (idleTimeoutMs !== undefined) this.idleTimeoutMs = idleTimeoutMs;
		if (urlChanged && (this._ready || this._connecting !== null)) this.close();
	}

	/**
	 * Open the socket (if needed) and run the initialize handshake. Concurrent
	 * callers share one in-flight attempt.
	 */
	async connect() {
		if (this._ready) return;
		if (this._connecting) return this._connecting;
		this._connecting = (async () => {
			await this._open();
			this.serverInfo = await this.request("initialize", {
				clientInfo: this.clientInfo,
				capabilities: { experimentalApi: true }
			});
			this._send({ method: "initialized" });
			this._ready = true;
			this._touchActivity();
		})().finally(() => {
			this._connecting = null;
		});
		return this._connecting;
	}

	/** @returns {Promise<void>} resolves once the socket is open. */
	_open() {
		return new Promise((resolve, reject) => {
			let settled = false;
			const ws = new this._WebSocketImpl(this.url);
			this._ws = ws;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				try { ws.close(); } catch { /* ignore */ }
				reject(new BridgeError("connect", `connect to ${this.url} timed out after ${this.connectTimeoutMs}ms`));
			}, this.connectTimeoutMs);
			ws.addEventListener("open", () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve();
			});
			ws.addEventListener("error", (event) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(new BridgeError("connect", `cannot connect to app-server at ${this.url}: ${event?.message ?? "socket error"}`));
				}
				// After open, errors surface through the close event.
			});
			ws.addEventListener("message", (event) => {
				// Ignore frames from a stale socket after a reconnect: they must
				// not resolve (or fail) requests owned by the new connection.
				if (this._ws === ws) this._onMessage(event);
			});
			ws.addEventListener("close", () => {
				clearTimeout(timer);
				if (!settled) {
					settled = true;
					reject(new BridgeError("connect", `connection to ${this.url} closed before opening`));
				}
				// A late close from a replaced socket must not tear down the
				// current connection's state (pending requests, ready flag).
				if (this._ws === ws) this._onClose();
			});
		});
	}

	/**
	 * Send a client request and await the matching response.
	 * @param {string} method
	 * @param {object} [params]
	 * @param {number} [timeoutMs] - overrides the default request budget.
	 * @returns {Promise<any>} the response `result`.
	 */
	request(method, params, timeoutMs = this.requestTimeoutMs) {
		if (this._ws === null) return Promise.reject(new BridgeError("closed", "not connected to app-server"));
		const id = ++this._nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pending.delete(String(id));
				reject(new BridgeError("timeout", `request ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this._pending.set(String(id), {
				method,
				resolve: (result) => { clearTimeout(timer); resolve(result); },
				reject: (error) => { clearTimeout(timer); reject(error); }
			});
			try {
				this._send({ id, method, params: params ?? {} });
				this._touchActivity();
			} catch (error) {
				this._pending.delete(String(id));
				clearTimeout(timer);
				reject(new BridgeError("closed", `failed to send ${method}: ${error.message}`));
			}
		});
	}

	/**
	 * Subscribe to server notifications. Listener receives `(method, params)`.
	 * @returns {() => void} disposer.
	 */
	onNotification(listener) {
		this._notificationListeners.add(listener);
		return () => this._notificationListeners.delete(listener);
	}

	/**
	 * Subscribe to connection teardown. Listener receives the `closed`
	 * BridgeError that in-flight requests were rejected with.
	 * @returns {() => void} disposer.
	 */
	onClose(listener) {
		this._closeListeners.add(listener);
		return () => this._closeListeners.delete(listener);
	}

	/**
	 * Register the handler for server-initiated requests (`item/tool/call`,
	 * approval prompts, ...). The handler's return value becomes the JSON-RPC
	 * `result`; a thrown error becomes a JSON-RPC error response. Requests
	 * arriving with no handler registered get a -32601 response so the server
	 * never waits forever.
	 * @param {(method: string, params: any) => Promise<any>} handler
	 */
	onServerRequest(handler) {
		this._serverRequestHandler = handler;
	}

	/** Close the socket and reject every in-flight request. */
	close() {
		const ws = this._ws;
		this._ws = null;
		if (ws !== null) {
			try { ws.close(); } catch { /* ignore */ }
		}
		this._onClose();
	}

	_send(message) {
		if (this._ws === null) throw new BridgeError("closed", "not connected to app-server");
		this._ws.send(JSON.stringify(message));
	}

	/**
	 * Best-effort send for server-request responses: when the socket is closed
	 * (or dies mid-write) the response is meaningless, so it is dropped
	 * silently instead of throwing into an unhandled rejection.
	 * @returns {boolean} whether the frame was handed to the socket.
	 */
	_trySend(message) {
		const ws = this._ws;
		if (ws === null) return false;
		const OPEN = this._WebSocketImpl.OPEN ?? 1;
		if (typeof ws.readyState === "number" && ws.readyState !== OPEN) return false;
		try {
			ws.send(JSON.stringify(message));
			this._touchActivity();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Reset the idle countdown. Called on every activity: request sent, frame
	 * received, server-request answered, handshake completed. The timer is
	 * unref'd so it never keeps the process alive on its own.
	 */
	_touchActivity() {
		this._disarmIdleTimer();
		if (!this._ready) return;
		if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) return;
		this._idleTimer = setTimeout(() => this._onIdle(), this.idleTimeoutMs);
		if (typeof this._idleTimer.unref === "function") this._idleTimer.unref();
	}

	_disarmIdleTimer() {
		if (this._idleTimer !== null) {
			clearTimeout(this._idleTimer);
			this._idleTimer = null;
		}
	}

	/**
	 * Idle countdown expired. In-flight work — an awaited request or a live
	 * notification listener (a turn being collected) — means the connection is
	 * in use even while the wire is quiet, so the countdown restarts instead
	 * of killing that work. Only a truly idle connection is closed; the next
	 * `connect()` re-opens it lazily.
	 */
	_onIdle() {
		this._idleTimer = null;
		if (!this._ready) return;
		if (this._pending.size > 0 || this._notificationListeners.size > 0) {
			this._touchActivity();
			return;
		}
		this.close();
	}

	_onClose() {
		this._disarmIdleTimer();
		this._ws = null;
		const wasReady = this._ready;
		this._ready = false;
		if (!wasReady && this._pending.size === 0 && this._closeListeners.size === 0) return;
		const error = new BridgeError("closed", `connection to app-server at ${this.url} closed`);
		for (const pending of this._pending.values()) pending.reject(error);
		this._pending.clear();
		for (const listener of this._closeListeners) {
			try {
				listener(error);
			} catch {
				// Listener failures must not break close dispatch.
			}
		}
	}

	_onMessage(event) {
		let message;
		try {
			message = JSON.parse(typeof event.data === "string" ? event.data : "");
		} catch {
			return; // unparseable frame: ignore, the protocol never carries non-JSON text
		}
		if (message === null || typeof message !== "object") return;
		this._touchActivity();
		const hasId = message.id !== undefined && message.id !== null;
		if (hasId && typeof message.method === "string") {
			this._onServerRequest(message);
		} else if (hasId) {
			this._onResponse(message);
		} else if (typeof message.method === "string") {
			for (const listener of this._notificationListeners) {
				try {
					listener(message.method, message.params);
				} catch {
					// Listener failures must not break frame dispatch.
				}
			}
		}
	}

	_onResponse(message) {
		const pending = this._pending.get(String(message.id));
		if (pending === undefined) return; // late/unknown response
		this._pending.delete(String(message.id));
		if (message.error !== undefined && message.error !== null) {
			const detail = message.error;
			pending.reject(new BridgeError("rpc", `${pending.method} failed: ${detail.message ?? JSON.stringify(detail)}`));
		} else {
			pending.resolve(message.result);
		}
	}

	async _onServerRequest(message) {
		const handler = this._serverRequestHandler;
		if (handler === null) {
			this._trySend({ id: message.id, error: { code: -32601, message: `client does not handle ${message.method}` } });
			return;
		}
		try {
			const result = await handler(message.method, message.params);
			this._trySend({ id: message.id, result: result ?? {} });
		} catch (error) {
			this._trySend({ id: message.id, error: { code: -32603, message: error?.message ?? String(error) } });
		}
	}
}
