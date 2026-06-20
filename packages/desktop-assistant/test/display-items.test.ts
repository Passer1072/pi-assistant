import { describe, expect, it } from "vitest";
import { buildDisplayItems } from "../renderer/src/display-items.ts";
import type { ChatMessageView, TimelineItem } from "../src/shared/types.ts";

describe("buildDisplayItems", () => {
	it("sorts mixed history by stable order before timestamp", () => {
		const messages: ChatMessageView[] = [
			{
				id: "assistant-late",
				role: "assistant",
				text: "assistant after tool",
				timestamp: 4_000,
				order: 4,
			},
			{
				id: "user-first",
				role: "user",
				text: "user first",
				timestamp: 9_000,
				order: 1,
			},
		];
		const timeline: TimelineItem[] = [
			{
				id: "tool-start",
				kind: "tool",
				title: "Tool started: open_app",
				status: "running",
				timestamp: 1_000,
				order: 2,
				detail: "{}",
			},
			{
				id: "tool-end",
				kind: "tool",
				title: "Tool finished: open_app",
				status: "succeeded",
				timestamp: 2_000,
				order: 3,
				detail: "{}",
			},
		];

		const items = buildDisplayItems(messages, timeline);

		expect(
			items.map((item) =>
				item.kind === "message"
					? `${item.message.order}:${item.message.role}`
					: `${item.item.order}:${item.item.title}`,
			),
		).toEqual(["1:user", "2:Tool started: open_app", "3:Tool finished: open_app", "4:assistant"]);
	});

	it("keeps messages ahead of tool items when order ties", () => {
		const messages: ChatMessageView[] = [
			{
				id: "assistant",
				role: "assistant",
				text: "same order message",
				timestamp: 5_000,
				order: 7,
			},
		];
		const timeline: TimelineItem[] = [
			{
				id: "confirmation",
				kind: "confirmation",
				title: "Awaiting approval",
				status: "blocked",
				timestamp: 1_000,
				order: 7,
				detail: "needs approval",
			},
		];

		const items = buildDisplayItems(messages, timeline);

		expect(items[0]?.kind).toBe("message");
		expect(items[1]?.kind).toBe("tool");
	});

	it("interleaves per-segment thinking boxes with the tool calls they precede", () => {
		const messages: ChatMessageView[] = [
			{ id: "user", role: "user", text: "go", timestamp: 1_000, order: 1 },
			{ id: "answer", role: "assistant", text: "done", timestamp: 6_000, order: 6 },
		];
		const timeline: TimelineItem[] = [
			{
				id: "think-2",
				kind: "thinking",
				title: "已深度思考",
				detail: "reason A",
				status: "succeeded",
				timestamp: 2_000,
				order: 2,
			},
			{
				id: "tool-3",
				kind: "tool",
				title: "Tool finished: open_app",
				status: "succeeded",
				timestamp: 3_000,
				order: 3,
				detail: "{}",
			},
			{
				id: "think-4",
				kind: "thinking",
				title: "已深度思考",
				detail: "reason B",
				status: "succeeded",
				timestamp: 4_000,
				order: 4,
			},
			{
				id: "tool-5",
				kind: "tool",
				title: "Tool finished: type_text",
				status: "succeeded",
				timestamp: 5_000,
				order: 5,
				detail: "{}",
			},
		];

		const items = buildDisplayItems(messages, timeline);

		expect(
			items.map((item) =>
				item.kind === "message"
					? `msg:${item.message.role}`
					: `${item.kind}:${item.kind === "thinking" ? item.item.detail : item.item.title}`,
			),
		).toEqual([
			"msg:user",
			"thinking:reason A",
			"tool:Tool finished: open_app",
			"thinking:reason B",
			"tool:Tool finished: type_text",
			"msg:assistant",
		]);
	});

	it("inserts compaction notices into the conversation flow", () => {
		const messages: ChatMessageView[] = [
			{ id: "user", role: "user", text: "go", timestamp: 1_000, order: 1 },
			{ id: "assistant", role: "assistant", text: "done", timestamp: 4_000, order: 4 },
		];
		const timeline: TimelineItem[] = [
			{
				id: "compaction",
				kind: "compaction",
				title: "上下文已压缩",
				status: "succeeded",
				timestamp: 2_000,
				order: 2,
			},
			{
				id: "retry",
				kind: "retry",
				title: "Retrying",
				status: "running",
				timestamp: 3_000,
				order: 3,
			},
		];

		const items = buildDisplayItems(messages, timeline);

		expect(items.map((item) => item.kind)).toEqual(["message", "notice", "message"]);
		expect(items[1]?.kind === "notice" ? items[1].item.kind : undefined).toBe("compaction");
	});
});
