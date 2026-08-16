import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnCollector } from "../src/events.js";

function makeCollector(options = {}) {
	return new TurnCollector({ threadId: "th_1", maxCommandOutputChars: 50, maxProcessChars: 500, ...options });
}

test("accumulates agent message deltas and completes on turn/completed", async () => {
	const collector = makeCollector();
	collector.handle("turn/started", { threadId: "th_1", turn: { id: "t1" } });
	collector.handle("item/agentMessage/delta", { threadId: "th_1", itemId: "a1", delta: "你好" });
	collector.handle("item/agentMessage/delta", { threadId: "th_1", itemId: "a1", delta: "，世界" });
	collector.handle("turn/completed", { threadId: "th_1", turn: { id: "t1", status: "completed", items: [] } });
	const outcome = await collector.done;
	assert.equal(outcome.status, "completed");
	assert.match(collector.renderText(), /你好，世界/);
});

test("ignores notifications for other threads", async () => {
	const collector = makeCollector();
	collector.handle("item/agentMessage/delta", { threadId: "th_OTHER", itemId: "a1", delta: "noise" });
	collector.handle("turn/completed", { threadId: "th_1", turn: { id: "t1", status: "completed", items: [] } });
	await collector.done;
	assert.match(collector.renderText(), /未产生最终文本回复/);
});

test("completed agentMessage item is authoritative over deltas", async () => {
	const collector = makeCollector();
	collector.handle("item/agentMessage/delta", { threadId: "th_1", itemId: "a1", delta: "partial" });
	collector.handle("item/completed", { threadId: "th_1", item: { type: "agentMessage", id: "a1", text: "final text" } });
	collector.handle("turn/completed", { threadId: "th_1", turn: { id: "t1", status: "completed", items: [] } });
	await collector.done;
	assert.match(collector.renderText(), /final text/);
	assert.doesNotMatch(collector.renderText(), /partial/);
});

test("falls back to turn.items when deltas were missed", async () => {
	const collector = makeCollector();
	collector.handle("turn/completed", {
		threadId: "th_1",
		turn: { id: "t1", status: "completed", items: [{ type: "agentMessage", id: "a9", text: "from items" }] }
	});
	await collector.done;
	assert.match(collector.renderText(), /from items/);
});

test("failed turns surface the server error message", async () => {
	const collector = makeCollector();
	collector.handle("turn/completed", {
		threadId: "th_1",
		turn: { id: "t1", status: "failed", error: { message: "model exploded" }, items: [] }
	});
	const outcome = await collector.done;
	assert.equal(outcome.status, "failed");
	assert.equal(outcome.error, "model exploded");
});

test("error notifications with willRetry:false end the turn; willRetry:true does not", async () => {
	const retried = makeCollector();
	retried.handle("error", { threadId: "th_1", turnId: "t1", error: { message: "transient" }, willRetry: true });
	assert.equal(retried.outcome, null);
	retried.handle("turn/completed", { threadId: "th_1", turn: { id: "t1", status: "completed", items: [] } });
	assert.equal((await retried.done).status, "completed");

	const fatal = makeCollector();
	fatal.handle("error", { threadId: "th_1", turnId: "t1", error: { message: "fatal" }, willRetry: false });
	const outcome = await fatal.done;
	assert.equal(outcome.status, "failed");
	assert.equal(outcome.error, "fatal");
});

test("command phases and bounded output tails appear in the summary", async () => {
	const collector = makeCollector();
	collector.handle("item/started", { threadId: "th_1", item: { type: "commandExecution", id: "c1", command: "ls -la", status: "inProgress" } });
	collector.handle("item/commandExecution/outputDelta", { threadId: "th_1", itemId: "c1", delta: "x".repeat(80) });
	collector.handle("item/completed", { threadId: "th_1", item: { type: "commandExecution", id: "c1", command: "ls -la", status: "completed", exitCode: 0 } });
	collector.handle("turn/completed", { threadId: "th_1", turn: { id: "t1", status: "completed", items: [] } });
	await collector.done;
	const text = collector.renderText();
	assert.match(text, /执行命令: ls -la/);
	assert.match(text, /命令完成: ls -la \(exit 0\)/);
	// Output tail capped at maxCommandOutputChars (50 of the 80 chars kept).
	assert.match(text, /\[命令输出\]/);
	assert.ok(!text.includes("x".repeat(80)));
	assert.ok(text.includes("x".repeat(50)));
});

test("process summary is capped at maxProcessChars", async () => {
	const collector = makeCollector();
	for (let i = 0; i < 60; i++) {
		collector.handle("item/started", { threadId: "th_1", item: { type: "commandExecution", id: `c${i}`, command: `cmd-${i}-padding-padding`, status: "inProgress" } });
	}
	collector.handle("turn/completed", { threadId: "th_1", turn: { id: "t1", status: "completed", items: [] } });
	await collector.done;
	const text = collector.renderText();
	assert.match(text, /过程摘要过长/);
});

test("aggregatedOutput on completion is used when no deltas arrived", async () => {
	const collector = makeCollector();
	collector.handle("item/started", { threadId: "th_1", item: { type: "commandExecution", id: "c1", command: "pwd", status: "inProgress" } });
	collector.handle("item/completed", {
		threadId: "th_1",
		item: { type: "commandExecution", id: "c1", command: "pwd", status: "completed", exitCode: 0, aggregatedOutput: "/tmp/work" }
	});
	collector.handle("turn/completed", { threadId: "th_1", turn: { id: "t1", status: "completed", items: [] } });
	await collector.done;
	assert.match(collector.renderText(), /\/tmp\/work/);
});
