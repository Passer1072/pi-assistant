export interface VirtualListItem {
	key: string;
}

export interface VirtualWindowInput {
	items: readonly VirtualListItem[];
	scrollTop: number;
	viewportHeight: number;
	listTop: number;
	measuredHeights: ReadonlyMap<string, number>;
	estimatedItemHeight: number;
	gap: number;
	overscan: number;
}

export interface VirtualListLayoutInput {
	items: readonly VirtualListItem[];
	measuredHeights: ReadonlyMap<string, number>;
	estimatedItemHeight: number;
	gap: number;
}

export interface VirtualListLayout {
	itemCount: number;
	offsets: readonly number[];
	spanBottoms: readonly number[];
	totalHeight: number;
	gap: number;
}

export interface VirtualWindowFromLayoutInput {
	layout: VirtualListLayout;
	scrollTop: number;
	viewportHeight: number;
	listTop: number;
	overscan: number;
}

export interface VirtualWindow {
	startIndex: number;
	endIndex: number;
	topSpacerHeight: number;
	bottomSpacerHeight: number;
	totalHeight: number;
}

export function calculateVirtualWindow(input: VirtualWindowInput): VirtualWindow {
	return calculateVirtualWindowFromLayout({
		layout: buildVirtualListLayout(input),
		scrollTop: input.scrollTop,
		viewportHeight: input.viewportHeight,
		listTop: input.listTop,
		overscan: input.overscan,
	});
}

export function buildVirtualListLayout(input: VirtualListLayoutInput): VirtualListLayout {
	const offsets: number[] = [];
	const spanBottoms: number[] = [];
	let offset = 0;
	for (let index = 0; index < input.items.length; index += 1) {
		offsets.push(offset);
		const height = itemHeight(input.measuredHeights, input.items[index].key, input.estimatedItemHeight);
		offset += height;
		if (index < input.items.length - 1) {
			offset += input.gap;
		}
		spanBottoms.push(offset);
	}
	return {
		itemCount: input.items.length,
		offsets,
		spanBottoms,
		totalHeight: offset,
		gap: input.gap,
	};
}

export function calculateVirtualWindowFromLayout(input: VirtualWindowFromLayoutInput): VirtualWindow {
	const { layout } = input;
	const itemCount = layout.itemCount;
	if (itemCount === 0) {
		return {
			startIndex: 0,
			endIndex: 0,
			topSpacerHeight: 0,
			bottomSpacerHeight: 0,
			totalHeight: 0,
		};
	}

	const viewportTop = Math.max(0, input.scrollTop - input.listTop - input.overscan);
	const viewportBottom = Math.max(
		viewportTop,
		input.scrollTop + input.viewportHeight - input.listTop + input.overscan,
	);

	const startIndex = Math.min(lowerBound(layout.spanBottoms, viewportTop), itemCount - 1);
	const offset = layout.offsets[startIndex] ?? 0;
	let endIndex = Math.min(firstGreaterThan(layout.spanBottoms, viewportBottom) + 1, itemCount);
	endIndex = Math.max(startIndex + 1, endIndex);
	const scanOffset = layout.spanBottoms[endIndex - 1] ?? offset;

	const topSpacerHeight = startIndex > 0 ? Math.max(0, offset - layout.gap) : 0;
	const bottomSpacerHeight = endIndex < itemCount ? Math.max(0, layout.totalHeight - scanOffset) : 0;

	return {
		startIndex,
		endIndex,
		topSpacerHeight,
		bottomSpacerHeight,
		totalHeight: layout.totalHeight,
	};
}

function itemHeight(measuredHeights: ReadonlyMap<string, number>, key: string, estimatedItemHeight: number): number {
	const measured = measuredHeights.get(key);
	if (measured !== undefined && Number.isFinite(measured) && measured > 0) return measured;
	return estimatedItemHeight;
}

function lowerBound(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const mid = low + Math.floor((high - low) / 2);
		if (values[mid] < target) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

function firstGreaterThan(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const mid = low + Math.floor((high - low) / 2);
		if (values[mid] <= target) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}
