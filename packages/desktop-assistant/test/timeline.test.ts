import { describe, expect, it } from "vitest";
import { eventToTimelineItem } from "../src/agent/timeline.ts";

describe("eventToTimelineItem", () => {
	it("maps compaction events to compaction timeline items", () => {
		const start = eventToTimelineItem({ type: "compaction_start", reason: "threshold" });
		const end = eventToTimelineItem({
			type: "compaction_end",
			reason: "threshold",
			result: {
				summary: "summary",
				firstKeptEntryId: "entry-1",
				tokensBefore: 100000,
			},
			aborted: false,
			willRetry: false,
		});

		expect(start).toMatchObject({
			kind: "compaction",
			title: "正在压缩上下文...",
			status: "running",
		});
		expect(end).toMatchObject({
			id: start?.id,
			kind: "compaction",
			title: "上下文已压缩",
			status: "succeeded",
		});
	});

	it("maps failed compaction end events", () => {
		const item = eventToTimelineItem({
			type: "compaction_end",
			reason: "overflow",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "failed",
		});

		expect(item).toMatchObject({
			kind: "compaction",
			title: "上下文压缩失败",
			status: "failed",
			detail: "failed",
		});
	});
});
