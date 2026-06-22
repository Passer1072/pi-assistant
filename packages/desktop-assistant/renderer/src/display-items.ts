import type { ChatMessageView, TimelineItem } from "../../src/shared/types.ts";

export type DisplayItem =
	| { kind: "message"; message: ChatMessageView }
	| { kind: "thinking"; item: TimelineItem }
	| { kind: "tool"; item: TimelineItem }
	| { kind: "artifact"; item: TimelineItem }
	| { kind: "notice"; item: TimelineItem };

export function buildDisplayItems(messages: ChatMessageView[], timeline: TimelineItem[]): DisplayItem[] {
	const thinkingItems = timeline.filter((item) => item.kind === "thinking");
	const toolItems = timeline.filter((item) => item.kind === "tool" || item.kind === "confirmation");
	const artifactItems = timeline.filter((item) => item.kind === "artifact" && (item.artifacts?.length ?? 0) > 0);
	const noticeItems = timeline.filter((item) => item.kind === "compaction");
	const all: Array<{ order: number; ts: number; item: DisplayItem }> = [
		...messages.map((message) => ({
			order: message.order,
			ts: message.timestamp,
			item: { kind: "message" as const, message },
		})),
		...thinkingItems.map((item) => ({
			order: item.order,
			ts: item.timestamp,
			item: { kind: "thinking" as const, item },
		})),
		...toolItems.map((item) => ({
			order: item.order,
			ts: item.timestamp,
			item: { kind: "tool" as const, item },
		})),
		...artifactItems.map((item) => ({
			order: item.order,
			ts: item.timestamp,
			item: { kind: "artifact" as const, item },
		})),
		...noticeItems.map((item) => ({
			order: item.order,
			ts: item.timestamp,
			item: { kind: "notice" as const, item },
		})),
	];
	all.sort((left, right) => {
		if (left.order !== right.order) {
			return left.order - right.order;
		}
		if (left.item.kind !== right.item.kind) {
			return displayKindRank(left.item.kind) - displayKindRank(right.item.kind);
		}
		return left.ts - right.ts;
	});
	return all.map((entry) => entry.item);
}

function displayKindRank(kind: DisplayItem["kind"]): number {
	if (kind === "message") return 0;
	// A reasoning segment precedes the tool call (or answer) it leads to, so on an
	// order tie it sorts ahead of tools/notices but behind the message it belongs to.
	if (kind === "thinking") return 1;
	if (kind === "notice") return 2;
	if (kind === "tool") return 3;
	// An artifact card sits right after the tool that produced it on an order tie.
	return 4;
}
