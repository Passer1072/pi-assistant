import { describe, expect, it } from "vitest";
import {
	buildVirtualListLayout,
	calculateVirtualWindow,
	calculateVirtualWindowFromLayout,
	type VirtualListItem,
	type VirtualWindow,
} from "../renderer/src/chat/virtual-list.ts";

function items(count: number): VirtualListItem[] {
	return Array.from({ length: count }, (_, index) => ({ key: `item-${index}` }));
}

describe("chat virtual list windowing", () => {
	it("renders only the visible range plus overscan for large conversations", () => {
		const result = calculateVirtualWindow({
			items: items(1000),
			scrollTop: 5000,
			viewportHeight: 600,
			listTop: 0,
			measuredHeights: new Map(),
			estimatedItemHeight: 50,
			gap: 10,
			overscan: 300,
		});

		expect(result.startIndex).toBeGreaterThan(70);
		expect(result.endIndex).toBeLessThan(105);
		expect(result.endIndex - result.startIndex).toBeLessThan(35);
		expect(result.topSpacerHeight).toBeGreaterThan(0);
		expect(result.bottomSpacerHeight).toBeGreaterThan(0);
	});

	it("includes the latest items when scrolled to the bottom", () => {
		const rowCount = 100;
		const estimatedHeight = 48;
		const gap = 8;
		const viewportHeight = 480;
		const totalHeight = rowCount * estimatedHeight + (rowCount - 1) * gap;
		const result = calculateVirtualWindow({
			items: items(rowCount),
			scrollTop: totalHeight - viewportHeight,
			viewportHeight,
			listTop: 0,
			measuredHeights: new Map(),
			estimatedItemHeight: estimatedHeight,
			gap,
			overscan: 160,
		});

		expect(result.endIndex).toBe(rowCount);
		expect(result.bottomSpacerHeight).toBe(0);
		expect(result.startIndex).toBeGreaterThan(75);
	});

	it("uses measured heights so prepended history preserves the same scroll anchor", () => {
		const measured = new Map<string, number>([
			["item-0", 120],
			["item-1", 90],
			["item-2", 64],
			["item-3", 72],
		]);
		const result = calculateVirtualWindow({
			items: items(6),
			scrollTop: 210,
			viewportHeight: 160,
			listTop: 0,
			measuredHeights: measured,
			estimatedItemHeight: 50,
			gap: 10,
			overscan: 0,
		});

		expect(result.startIndex).toBe(1);
		expect(result.topSpacerHeight).toBe(120);
		expect(result.endIndex).toBe(4);
	});

	it("reuses a precomputed layout for scroll-only recalculation", () => {
		const measured = new Map<string, number>([
			["item-2", 90],
			["item-3", 30],
			["item-8", 130],
		]);
		const listItems = items(16);
		const layout = buildVirtualListLayout({
			items: listItems,
			measuredHeights: measured,
			estimatedItemHeight: 50,
			gap: 10,
		});

		expect(layout.totalHeight).toBe(referenceTotalHeight(listItems, measured, 50, 10));

		for (const scrollTop of [0, 1, 59, 60, 210, 560, 900]) {
			const fromLayout = calculateVirtualWindowFromLayout({
				layout,
				scrollTop,
				viewportHeight: 160,
				listTop: 0,
				overscan: 25,
			});
			const direct = calculateVirtualWindow({
				items: listItems,
				scrollTop,
				viewportHeight: 160,
				listTop: 0,
				measuredHeights: measured,
				estimatedItemHeight: 50,
				gap: 10,
				overscan: 25,
			});

			expect(fromLayout).toEqual(direct);
			expect(fromLayout).toEqual(referenceWindow(listItems, measured, scrollTop, 160, 0, 50, 10, 25));
		}
	});
});

function referenceWindow(
	listItems: readonly VirtualListItem[],
	measuredHeights: ReadonlyMap<string, number>,
	scrollTop: number,
	viewportHeight: number,
	listTop: number,
	estimatedItemHeight: number,
	gap: number,
	overscan: number,
): VirtualWindow {
	const itemCount = listItems.length;
	if (itemCount === 0) {
		return {
			startIndex: 0,
			endIndex: 0,
			topSpacerHeight: 0,
			bottomSpacerHeight: 0,
			totalHeight: 0,
		};
	}

	const heights = listItems.map((item) => referenceItemHeight(measuredHeights, item.key, estimatedItemHeight));
	const totalHeight = referenceTotalHeight(listItems, measuredHeights, estimatedItemHeight, gap);
	const viewportTop = Math.max(0, scrollTop - listTop - overscan);
	const viewportBottom = Math.max(viewportTop, scrollTop + viewportHeight - listTop + overscan);

	let startIndex = 0;
	let offset = 0;
	while (startIndex < itemCount) {
		const rowBottom = offset + heights[startIndex];
		const spanBottom = rowBottom + (startIndex < itemCount - 1 ? gap : 0);
		if (spanBottom >= viewportTop) break;
		offset = spanBottom;
		startIndex += 1;
	}

	if (startIndex >= itemCount) {
		startIndex = itemCount - 1;
		offset = 0;
		for (let index = 0; index < startIndex; index += 1) {
			offset += heights[index] + gap;
		}
	}

	let endIndex = startIndex;
	let scanOffset = offset;
	while (endIndex < itemCount && scanOffset <= viewportBottom) {
		scanOffset += heights[endIndex];
		if (endIndex < itemCount - 1) {
			scanOffset += gap;
		}
		endIndex += 1;
	}
	endIndex = Math.max(startIndex + 1, endIndex);

	return {
		startIndex,
		endIndex,
		topSpacerHeight: startIndex > 0 ? Math.max(0, offset - gap) : 0,
		bottomSpacerHeight: endIndex < itemCount ? Math.max(0, totalHeight - scanOffset) : 0,
		totalHeight,
	};
}

function referenceTotalHeight(
	listItems: readonly VirtualListItem[],
	measuredHeights: ReadonlyMap<string, number>,
	estimatedItemHeight: number,
	gap: number,
): number {
	if (listItems.length === 0) return 0;
	return (
		listItems.reduce(
			(total, item) => total + referenceItemHeight(measuredHeights, item.key, estimatedItemHeight),
			0,
		) +
		gap * (listItems.length - 1)
	);
}

function referenceItemHeight(
	measuredHeights: ReadonlyMap<string, number>,
	key: string,
	estimatedItemHeight: number,
): number {
	const measured = measuredHeights.get(key);
	if (measured !== undefined && Number.isFinite(measured) && measured > 0) return measured;
	return estimatedItemHeight;
}
