/**
 * dsh session <-> codex thread mapping plus per-session turn serialization.
 *
 * v0.1.0 keeps the mapping in memory only: a bridge (dsh) restart loses it,
 * which the tool description tells the model to handle by passing an explicit
 * `thread_id`.
 * @module dsh-codex-bridge/thread
 */
export class ThreadMap {
	/**
	 * @param {number} [maxEntries] - cap on stored session->thread mappings;
	 *   the least recently used entry is evicted beyond the cap (the mapping
	 *   is a convenience cache: an evicted session simply starts a new thread).
	 */
	constructor(maxEntries = 256) {
		this._maxEntries = maxEntries;
		this._threads = new Map();
		this._queues = new Map();
	}

	/**
	 * @param {string} sessionKey - dsh session id (or "default").
	 * @returns {string | undefined} the codex thread id, when known.
	 */
	get(sessionKey) {
		const threadId = this._threads.get(sessionKey);
		if (threadId !== undefined) {
			// LRU refresh: re-insert at the recency end of the Map.
			this._threads.delete(sessionKey);
			this._threads.set(sessionKey, threadId);
		}
		return threadId;
	}

	/** @param {string} sessionKey @param {string} threadId */
	set(sessionKey, threadId) {
		this._threads.delete(sessionKey);
		this._threads.set(sessionKey, threadId);
		while (this._threads.size > this._maxEntries) {
			this._threads.delete(this._threads.keys().next().value);
		}
	}

	/** @param {string} sessionKey */
	delete(sessionKey) {
		this._threads.delete(sessionKey);
	}

	/**
	 * Run `fn` strictly after the previous call for the same session key
	 * settles. Codex allows one active turn per thread; the dsh model may emit
	 * parallel `codex` calls that share a thread, so they are queued here.
	 * @param {string} sessionKey
	 * @param {() => Promise<any>} fn
	 */
	runSerialized(sessionKey, fn) {
		const previous = this._queues.get(sessionKey) ?? Promise.resolve();
		const run = previous.then(() => fn());
		const tail = run.then(() => undefined, () => undefined);
		this._queues.set(sessionKey, tail);
		// Drop the entry once the queue drains so `_queues` cannot grow unbounded.
		tail.then(() => {
			if (this._queues.get(sessionKey) === tail) this._queues.delete(sessionKey);
		});
		return run;
	}
}
