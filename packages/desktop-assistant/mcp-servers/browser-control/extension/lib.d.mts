export interface CursorPoint {
	x: number;
	y: number;
}

export interface CompactAxNodeInput {
	nodeId: string;
	parentId?: string;
	ignored?: boolean;
	role?: { value?: string };
	name?: { value?: string };
	value?: { value?: unknown };
	childIds?: string[];
}

export interface CompactAxNodeOutput {
	role: string;
	name?: string;
	value?: string;
	level: number;
	childCount: number;
}

export interface FrameTreeInput {
	frame?: {
		id?: string;
		parentId?: string;
		url?: string;
		name?: string;
		crossOriginIsolatedContextType?: string;
	};
	childFrames?: FrameTreeInput[];
}

export interface FlattenedFrame {
	frameId?: string;
	parentId?: string;
	url?: string;
	name?: string;
	depth: number;
	crossOrigin: boolean;
}

export function compactAxNodes(nodes: CompactAxNodeInput[], max?: number): CompactAxNodeOutput[];

export function createTabScheduler(): {
	run<T>(key: string, fn: () => Promise<T>): Promise<T>;
	delete(key: string): void;
	readonly size: number;
};

export function cursorPath(
	from: CursorPoint | undefined,
	to: CursorPoint,
	opts?: { rng?: () => number; steps?: number },
): CursorPoint[];

export function flattenFrameTree(frameTree: FrameTreeInput, depth?: number, out?: FlattenedFrame[]): FlattenedFrame[];
