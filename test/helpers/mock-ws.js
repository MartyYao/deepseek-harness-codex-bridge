/**
 * In-memory WebSocket mock: the constructor captures each instance, and the
 * test drives the server side (`serverOpen` / `serverSend` / `serverError` /
 * `serverClose`). Every `send` is captured parsed in `sent`.
 */
export class MockWebSocket {
	static instances = [];

	static reset() {
		MockWebSocket.instances = [];
	}

	/** @returns {MockWebSocket} the most recently constructed instance. */
	static latest() {
		return MockWebSocket.instances[MockWebSocket.instances.length - 1];
	}

	constructor(url) {
		this.url = url;
		this.sent = [];
		this.readyState = MockWebSocket.CONNECTING;
		this._listeners = new Map();
		MockWebSocket.instances.push(this);
	}

	addEventListener(type, listener) {
		if (!this._listeners.has(type)) this._listeners.set(type, []);
		this._listeners.get(type).push(listener);
	}

	removeEventListener(type, listener) {
		const list = this._listeners.get(type);
		if (list === undefined) return;
		const index = list.indexOf(listener);
		if (index >= 0) list.splice(index, 1);
	}

	send(data) {
		this.sent.push(JSON.parse(data));
	}

	close() {
		if (this.readyState === MockWebSocket.CLOSED) return;
		this.readyState = MockWebSocket.CLOSED;
		this._emit("close", {});
	}

	// ---- server-side drivers ----

	serverOpen() {
		this.readyState = MockWebSocket.OPEN;
		this._emit("open", {});
	}

	/** Send one server->client frame (object is JSON-encoded). */
	serverSend(message) {
		this._emit("message", { data: JSON.stringify(message) });
	}

	serverError(message = "mock socket error") {
		this._emit("error", { message });
	}

	serverClose() {
		this.close();
	}

	_emit(type, event) {
		for (const listener of this._listeners.get(type) ?? []) listener(event);
	}
}

MockWebSocket.CONNECTING = 0;
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;

/** Flush the microtask queue a few times so async bridge internals settle. */
export async function flush(turns = 10) {
	for (let i = 0; i < turns; i++) await Promise.resolve();
}

/**
 * Drive a bridge through a successful connect: open the socket, answer the
 * initialize request, and observe the initialized notification.
 */
export async function driveConnect(bridge) {
	const pending = bridge.connect();
	await flush();
	const ws = MockWebSocket.latest();
	ws.serverOpen();
	await flush();
	const initRequest = ws.sent.find((message) => message.method === "initialize");
	ws.serverSend({ id: initRequest.id, result: { userAgent: "mock-codex/0.0.0" } });
	await pending;
	return ws;
}
