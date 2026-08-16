/**
 * Translation from codex app-server turn notifications to an accumulated
 * tool-result view: the final agent message plus a bounded process summary
 * (phase list + command output tails).
 *
 * dsh has no token-level streaming for tool calls (see SPEC §2.2 "诚实边界"),
 * so the collector aggregates during the turn and renders once at completion.
 * @module dsh-codex-bridge/events
 */

/** One terminal turn outcome. @typedef {{status: string, error: string | null}} TurnOutcome */

export class TurnCollector {
	/**
	 * @param {object} options
	 * @param {string} options.threadId - only notifications for this thread are tracked.
	 * @param {number} [options.maxCommandOutputChars] - per-command kept tail.
	 * @param {number} [options.maxProcessChars] - total process-summary cap.
	 */
	constructor({ threadId, maxCommandOutputChars = 4_000, maxProcessChars = 8_000 }) {
		this.threadId = threadId;
		this.maxCommandOutputChars = maxCommandOutputChars;
		this.maxProcessChars = maxProcessChars;
		/** @type {string | null} */
		this.turnId = null;
		/** Ordered phase lines ("执行命令: ...", "思考", ...). */
		this.phases = [];
		/** itemId -> accumulated agent message text, plus completion order. */
		this._agentText = new Map();
		this._agentOrder = [];
		/** itemId -> { command, output, status, exitCode }. */
		this.commands = new Map();
		/** itemId -> accumulated reasoning summary text. */
		this._reasoning = new Map();
		this.done = new Promise((resolve) => {
			this._settle = resolve;
		});
		/** @type {TurnOutcome | null} */
		this.outcome = null;
	}

	/**
	 * Feed one server notification. Notifications for other threads are ignored.
	 * @param {string} method
	 * @param {any} params
	 */
	handle(method, params) {
		if (this.outcome !== null) return; // already settled
		if (params === null || typeof params !== "object") return;
		if (params.threadId !== this.threadId) return;
		switch (method) {
			case "turn/started":
				this.turnId = params.turn?.id ?? null;
				break;
			case "item/started":
				this._onItemStarted(params.item);
				break;
			case "item/completed":
				this._onItemCompleted(params.item);
				break;
			case "item/agentMessage/delta":
				this._appendAgent(params.itemId, params.delta ?? "");
				break;
			case "item/reasoning/summaryTextDelta":
				this._appendMap(this._reasoning, params.itemId, params.delta ?? "");
				break;
			case "item/commandExecution/outputDelta":
				this._appendCommandOutput(params.itemId, params.delta ?? "");
				break;
			case "turn/completed":
				this._onTurnCompleted(params.turn);
				break;
			case "error":
				// Transient upstream errors arrive with willRetry: true and the
				// turn continues; only a final error ends the turn early.
				if (params.willRetry === false) {
					this._finish({ status: "failed", error: params.error?.message ?? "unknown codex error" });
				}
				break;
			default:
				break;
		}
	}

	/**
	 * Render the model-facing tool result text: final agent message, then a
	 * bounded process summary.
	 * @returns {string}
	 */
	renderText() {
		const agentText = this._agentOrder.map((id) => this._agentText.get(id)).join("\n").trim();
		const sections = [];
		sections.push(agentText.length > 0 ? agentText : "(codex 未产生最终文本回复)");
		const summary = this._renderProcess();
		if (summary.length > 0) sections.push(summary);
		return sections.join("\n\n---\n\n");
	}

	/** @returns {string} process summary, possibly empty. */
	_renderProcess() {
		const lines = [];
		if (this.phases.length > 0) {
			lines.push("[过程摘要]", ...this.phases.map((phase) => `- ${phase}`));
		}
		const outputs = [];
		for (const command of this.commands.values()) {
			if (command.output.length === 0) continue;
			const status = command.exitCode !== null ? `exit ${command.exitCode}` : command.status ?? "?";
			outputs.push(`$ ${command.command ?? "(command)"}  [${status}]\n${command.output}`);
		}
		if (outputs.length > 0) {
			lines.push("", "[命令输出]", outputs.join("\n\n"));
		}
		let text = lines.join("\n");
		if (text.length > this.maxProcessChars) {
			text = `[过程摘要过长，仅保留尾部 ${this.maxProcessChars} 字符]\n` + text.slice(-this.maxProcessChars);
		}
		return text;
	}

	_phase(label) {
		if (this.phases[this.phases.length - 1] !== label) this.phases.push(label);
	}

	_onItemStarted(item) {
		if (item === null || typeof item !== "object") return;
		switch (item.type) {
			case "reasoning":
				this._phase("思考中");
				break;
			case "commandExecution":
				this.commands.set(item.id, { command: stringifyCommand(item.command), output: "", status: item.status ?? "inProgress", exitCode: null });
				this._phase(`执行命令: ${stringifyCommand(item.command)}`);
				break;
			case "fileChange":
				this._phase("修改文件");
				break;
			case "webSearch":
				this._phase(`搜索: ${item.query ?? ""}`.trimEnd());
				break;
			case "mcpToolCall":
				this._phase(`调用工具: ${item.server ?? ""}/${item.tool ?? ""}`);
				break;
			case "dynamicToolCall":
				this._phase(`调用 dsh 工具: ${item.tool ?? ""}`);
				break;
			default:
				break;
		}
	}

	_onItemCompleted(item) {
		if (item === null || typeof item !== "object") return;
		switch (item.type) {
			case "agentMessage":
				// The completed item is authoritative over accumulated deltas.
				if (typeof item.text === "string") {
					if (!this._agentText.has(item.id)) this._agentOrder.push(item.id);
					this._agentText.set(item.id, item.text);
				}
				this._phase("生成回复");
				break;
			case "reasoning":
				this._phase("思考完成");
				break;
			case "commandExecution": {
				const tracked = this.commands.get(item.id);
				const output = typeof item.aggregatedOutput === "string" && tracked !== undefined && tracked.output.length === 0
					? tail(item.aggregatedOutput, this.maxCommandOutputChars)
					: tracked?.output ?? "";
				this.commands.set(item.id, {
					command: tracked?.command ?? stringifyCommand(item.command),
					output,
					status: item.status ?? "completed",
					exitCode: typeof item.exitCode === "number" ? item.exitCode : null
				});
				this._phase(`命令完成: ${stringifyCommand(item.command)} (exit ${item.exitCode ?? "?"})`);
				break;
			}
			case "fileChange":
				this._phase(`文件修改完成 (${Array.isArray(item.changes) ? item.changes.length : "?"} 个文件)`);
				break;
			case "dynamicToolCall":
				this._phase(`dsh 工具返回: ${item.tool ?? ""} (${item.success === false ? "失败" : "成功"})`);
				break;
			default:
				break;
		}
	}

	_onTurnCompleted(turn) {
		if (turn === null || typeof turn !== "object") {
			this._finish({ status: "failed", error: "malformed turn/completed notification" });
			return;
		}
		const status = turn.status ?? "failed";
		// Fall back to the durable item list when deltas were missed.
		if (this._agentOrder.length === 0 && Array.isArray(turn.items)) {
			for (const item of turn.items) {
				if (item?.type === "agentMessage" && typeof item.text === "string") {
					this._agentOrder.push(item.id);
					this._agentText.set(item.id, item.text);
				}
			}
		}
		this._finish({ status, error: turn.error?.message ?? null });
	}

	_finish(outcome) {
		if (this.outcome !== null) return;
		this.outcome = outcome;
		this._settle(outcome);
	}

	_appendAgent(itemId, delta) {
		if (typeof itemId !== "string") return;
		if (!this._agentText.has(itemId)) this._agentOrder.push(itemId);
		this._agentText.set(itemId, (this._agentText.get(itemId) ?? "") + delta);
	}

	_appendMap(map, itemId, delta) {
		if (typeof itemId !== "string") return;
		map.set(itemId, (map.get(itemId) ?? "") + delta);
	}

	_appendCommandOutput(itemId, delta) {
		const tracked = this.commands.get(itemId);
		if (tracked === undefined) return; // delta without item/started: ignore
		tracked.output = tail(tracked.output + delta, this.maxCommandOutputChars);
	}
}

/** Keep the last `max` characters of `text`. */
function tail(text, max) {
	return text.length <= max ? text : text.slice(-max);
}

/** Command fields arrive as a string or an argv array depending on the item source. */
function stringifyCommand(command) {
	if (Array.isArray(command)) return command.join(" ");
	if (typeof command === "string") return command;
	return "(command)";
}
