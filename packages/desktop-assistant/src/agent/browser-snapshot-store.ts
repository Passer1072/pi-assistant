import { createHash, randomUUID } from "node:crypto";

export type BrowserSnapshotField = "text" | "html" | "links" | "forms" | "tables" | "interactive" | "raw";

export type BrowserSnapshotDetailLevel = "summary" | "full";

export interface BrowserSnapshotSource {
	sourceKey?: string;
	toolName: string;
	action: string;
	url?: string;
	title?: string;
	stdout?: string;
	stderr?: string;
	observedState?: unknown;
	raw: unknown;
}

export interface BrowserSnapshot {
	id: string;
	previousSnapshotId?: string;
	url?: string;
	title?: string;
	action: string;
	toolName: string;
	hash: string;
	createdAt: number;
	unchanged: boolean;
	summary: string;
	changeSummary?: string;
	stdout?: string;
	stderr?: string;
	observedState?: unknown;
	raw: unknown;
	extracted: BrowserSnapshotExtracted;
}

export interface BrowserSnapshotExtracted {
	text?: string;
	html?: string;
	links?: unknown[];
	forms?: unknown[];
	tables?: unknown[];
	interactive?: unknown[];
	elements?: unknown[];
	buttons?: unknown[];
}

export interface BrowserSnapshotReference {
	tokenSaving: true;
	snapshotId: string;
	previousSnapshotId?: string;
	unchanged?: boolean;
	url?: string;
	title?: string;
	summary: string;
	changeSummary?: string;
	omittedFields?: BrowserSnapshotField[];
	instruction: string;
}

export interface BrowserSnapshotReadRequest {
	snapshotId: string;
	detailLevel?: BrowserSnapshotDetailLevel;
	fields?: BrowserSnapshotField[];
	maxTextLength?: number;
}

export interface BrowserSnapshotReadResult {
	ok: boolean;
	snapshotId: string;
	error?: string;
	url?: string;
	title?: string;
	createdAt?: number;
	unchanged?: boolean;
	previousSnapshotId?: string;
	summary?: string;
	changeSummary?: string;
	fields?: Record<string, unknown>;
	truncated?: boolean;
	instruction?: string;
}

const DEFAULT_TEXT_LIMIT = 8000;
const SUMMARY_TEXT_LIMIT = 1800;
const FIELD_TEXT_LIMIT = 12000;
const ARRAY_SUMMARY_LIMIT = 12;
const ACTIONABLE_SUMMARY_LIMIT = 24;
const MAX_SNAPSHOTS = 80;
const MAX_SNAPSHOT_TOTAL_BYTES = 20 * 1024 * 1024;
const KEEP_HEAVY_FIELDS_RECENT = 6;

export class BrowserSnapshotStore {
	private readonly snapshots = new Map<string, BrowserSnapshot>();
	private readonly latestByPageKey = new Map<string, string>();
	private readonly snapshotBySourceKey = new Map<string, string>();

	create(source: BrowserSnapshotSource): BrowserSnapshot {
		if (source.sourceKey) {
			const existingId = this.snapshotBySourceKey.get(source.sourceKey);
			const existing = existingId ? this.snapshots.get(existingId) : undefined;
			if (existing) return existing;
		}
		const extracted = extractBrowserSnapshot(source);
		const hash = stableHash({
			url: source.url,
			title: source.title,
			action: source.action,
			text: extracted.text,
			html: extracted.html,
			links: extracted.links,
			forms: extracted.forms,
			tables: extracted.tables,
			interactive: extracted.interactive,
			elements: extracted.elements,
			buttons: extracted.buttons,
			stdout: source.stdout,
			stderr: source.stderr,
		});
		const pageKey = snapshotPageKey(source, extracted);
		const previousSnapshotId = this.latestByPageKey.get(pageKey);
		const previous = previousSnapshotId ? this.snapshots.get(previousSnapshotId) : undefined;
		const unchanged = previous?.hash === hash;
		const snapshot: BrowserSnapshot = {
			id: `browser-snap-${randomUUID()}`,
			previousSnapshotId,
			url: source.url,
			title: source.title,
			action: source.action,
			toolName: source.toolName,
			hash,
			createdAt: Date.now(),
			unchanged,
			summary: buildSummary(source, extracted),
			changeSummary: buildChangeSummary(previous, source, extracted, unchanged),
			stdout: source.stdout,
			stderr: source.stderr,
			observedState: source.observedState,
			raw: source.raw,
			extracted,
		};
		this.snapshots.set(snapshot.id, snapshot);
		if (source.sourceKey) this.snapshotBySourceKey.set(source.sourceKey, snapshot.id);
		this.latestByPageKey.set(pageKey, snapshot.id);
		this.evictOldSnapshots();
		return snapshot;
	}

	toReference(snapshot: BrowserSnapshot): BrowserSnapshotReference {
		return {
			tokenSaving: true,
			snapshotId: snapshot.id,
			previousSnapshotId: snapshot.previousSnapshotId,
			unchanged: snapshot.unchanged || undefined,
			url: snapshot.url,
			title: snapshot.title,
			summary: snapshot.summary,
			changeSummary: snapshot.changeSummary,
			omittedFields: omittedFields(snapshot.extracted),
			instruction: "Use browser_snapshot_read only when this summary is insufficient.",
		};
	}

	read(request: BrowserSnapshotReadRequest): BrowserSnapshotReadResult {
		const snapshot = this.snapshots.get(request.snapshotId);
		if (!snapshot) {
			return {
				ok: false,
				snapshotId: request.snapshotId,
				error: "Unknown browser snapshot id.",
			};
		}
		const detailLevel = request.detailLevel ?? "summary";
		const maxTextLength = normalizeTextLimit(
			request.maxTextLength,
			detailLevel === "full" ? FIELD_TEXT_LIMIT : DEFAULT_TEXT_LIMIT,
		);
		const fields =
			request.fields ?? (detailLevel === "full" ? ["text", "links", "forms", "tables", "interactive"] : []);
		const outputFields: Record<string, unknown> = {};
		let truncated = false;
		for (const field of fields) {
			const value = valueForField(snapshot, field);
			const limited = limitField(value, maxTextLength);
			outputFields[field] = limited.value;
			truncated = truncated || limited.truncated;
		}
		return {
			ok: true,
			snapshotId: snapshot.id,
			url: snapshot.url,
			title: snapshot.title,
			createdAt: snapshot.createdAt,
			unchanged: snapshot.unchanged,
			previousSnapshotId: snapshot.previousSnapshotId,
			summary: snapshot.summary,
			changeSummary: snapshot.changeSummary,
			fields: Object.keys(outputFields).length > 0 ? outputFields : undefined,
			truncated,
			instruction: "Use the smallest fields needed. Request html/raw only when page structure is required.",
		};
	}

	getSnapshotCount(): number {
		return this.snapshots.size;
	}

	private evictOldSnapshots(): void {
		while (this.snapshots.size > MAX_SNAPSHOTS) {
			const oldest = this.oldestSnapshot();
			if (!oldest) return;
			this.deleteSnapshot(oldest.id);
		}
		this.trimHeavyFields();
		let totalBytes = this.totalApproxBytes();
		while (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES && this.snapshots.size > KEEP_HEAVY_FIELDS_RECENT) {
			const oldest = this.oldestSnapshot();
			if (!oldest) return;
			totalBytes -= approximateSnapshotBytes(oldest);
			this.deleteSnapshot(oldest.id);
		}
	}

	private trimHeavyFields(): void {
		const ordered = [...this.snapshots.values()].sort((left, right) => right.createdAt - left.createdAt);
		for (let index = KEEP_HEAVY_FIELDS_RECENT; index < ordered.length; index += 1) {
			const snapshot = ordered[index];
			snapshot.raw = undefined;
			snapshot.extracted.html = undefined;
		}
	}

	private oldestSnapshot(): BrowserSnapshot | undefined {
		return [...this.snapshots.values()].sort((left, right) => left.createdAt - right.createdAt)[0];
	}

	private totalApproxBytes(): number {
		let total = 0;
		for (const snapshot of this.snapshots.values()) {
			total += approximateSnapshotBytes(snapshot);
		}
		return total;
	}

	private deleteSnapshot(snapshotId: string): void {
		this.snapshots.delete(snapshotId);
		for (const [key, id] of this.snapshotBySourceKey.entries()) {
			if (id === snapshotId) this.snapshotBySourceKey.delete(key);
		}
		for (const [key, id] of this.latestByPageKey.entries()) {
			if (id === snapshotId) this.latestByPageKey.delete(key);
		}
	}
}

function approximateSnapshotBytes(snapshot: BrowserSnapshot): number {
	let total = 0;
	total += snapshot.summary.length;
	total += snapshot.changeSummary?.length ?? 0;
	total += snapshot.stdout?.length ?? 0;
	total += snapshot.stderr?.length ?? 0;
	total += snapshot.url?.length ?? 0;
	total += snapshot.title?.length ?? 0;
	total += snapshot.extracted.text?.length ?? 0;
	total += snapshot.extracted.html?.length ?? 0;
	total += safeJsonLength(snapshot.raw);
	total += safeJsonLength(snapshot.observedState);
	total += safeJsonLength(snapshot.extracted.links);
	total += safeJsonLength(snapshot.extracted.forms);
	total += safeJsonLength(snapshot.extracted.tables);
	total += safeJsonLength(snapshot.extracted.interactive);
	total += safeJsonLength(snapshot.extracted.elements);
	total += safeJsonLength(snapshot.extracted.buttons);
	return total;
}

function safeJsonLength(value: unknown): number {
	if (value === undefined || value === null) return 0;
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return String(value).length;
	}
}

function extractBrowserSnapshot(source: BrowserSnapshotSource): BrowserSnapshotExtracted {
	const values = [parseJson(source.stdout), source.observedState, source.raw];
	const extracted: BrowserSnapshotExtracted = {};
	for (const value of values) {
		mergeExtracted(extracted, extractFromUnknown(value));
	}
	return extracted;
}

function mergeExtracted(target: BrowserSnapshotExtracted, source: BrowserSnapshotExtracted): void {
	target.text ??= source.text;
	target.html ??= source.html;
	target.links ??= source.links;
	target.forms ??= source.forms;
	target.tables ??= source.tables;
	target.interactive ??= source.interactive;
	target.elements ??= source.elements;
	target.buttons ??= source.buttons;
}

function extractFromUnknown(value: unknown, depth = 0): BrowserSnapshotExtracted {
	const found: BrowserSnapshotExtracted = {};
	const nestedValues: unknown[] = [];
	visitUnknown(value, (key, entry) => {
		if (key === "text" && typeof entry === "string" && !found.text) found.text = entry;
		if (key === "html" && typeof entry === "string" && !found.html) found.html = entry;
		if (key === "links" && Array.isArray(entry) && !found.links) found.links = entry;
		if (key === "forms" && Array.isArray(entry) && !found.forms) found.forms = entry;
		if (key === "tables" && Array.isArray(entry) && !found.tables) found.tables = entry;
		if (key === "interactive" && Array.isArray(entry) && !found.interactive) found.interactive = entry;
		if (key === "elements" && Array.isArray(entry) && !found.elements) found.elements = entry;
		if (key === "buttons" && Array.isArray(entry) && !found.buttons) found.buttons = entry;
		if (depth < 2 && isJsonContainerText(key, entry)) nestedValues.push(parseJson(entry));
		if (key === "url" && typeof entry === "string") {
			// URL is extracted in token-saving-context where DesktopToolResult is available.
		}
	});
	for (const nestedValue of nestedValues) {
		mergeExtracted(found, extractFromUnknown(nestedValue, depth + 1));
	}
	return found;
}

function visitUnknown(value: unknown, visitor: (key: string, value: unknown) => void): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) visitUnknown(item, visitor);
		return;
	}
	for (const [key, entry] of Object.entries(value)) {
		visitor(key, entry);
		visitUnknown(entry, visitor);
	}
}

function buildSummary(source: BrowserSnapshotSource, extracted: BrowserSnapshotExtracted): string {
	const parts: string[] = [];
	if (source.title) parts.push(`Title: ${source.title}`);
	if (source.url) parts.push(`URL: ${source.url}`);
	if (extracted.text) {
		parts.push(`Text: ${compactWhitespace(extracted.text).slice(0, SUMMARY_TEXT_LIMIT)}`);
	}
	if (extracted.links?.length) {
		parts.push(`Links: ${summarizeArray(extracted.links, ARRAY_SUMMARY_LIMIT)}`);
	}
	if (extracted.forms?.length) {
		parts.push(`Forms: ${summarizeArray(extracted.forms, ARRAY_SUMMARY_LIMIT)}`);
	}
	const actionable = buildActionableSummary(extracted);
	if (actionable) parts.push(actionable);
	if (extracted.tables?.length) {
		parts.push(`Tables: ${summarizeArray(extracted.tables, ARRAY_SUMMARY_LIMIT)}`);
	}
	if (!parts.length && source.stdout) {
		parts.push(`Output: ${compactWhitespace(source.stdout).slice(0, SUMMARY_TEXT_LIMIT)}`);
	}
	return parts.join("\n");
}

function buildChangeSummary(
	previous: BrowserSnapshot | undefined,
	source: BrowserSnapshotSource,
	extracted: BrowserSnapshotExtracted,
	unchanged: boolean,
): string | undefined {
	if (!previous) return "Initial browser snapshot for this page.";
	if (unchanged) return "Page content is unchanged from the previous snapshot.";
	const changes: string[] = [];
	const textDelta = (extracted.text?.length ?? 0) - (previous.extracted.text?.length ?? 0);
	if (textDelta !== 0) changes.push(`text length ${formatDelta(textDelta)} chars`);
	for (const field of ["links", "forms", "tables", "interactive"] as const) {
		const delta = (extracted[field]?.length ?? 0) - (previous.extracted[field]?.length ?? 0);
		if (delta !== 0) changes.push(`${field} count ${formatDelta(delta)}`);
	}
	for (const field of ["elements", "buttons"] as const) {
		const delta = (extracted[field]?.length ?? 0) - (previous.extracted[field]?.length ?? 0);
		if (delta !== 0) changes.push(`${field} count ${formatDelta(delta)}`);
	}
	if (source.title && previous.title && source.title !== previous.title) {
		changes.push(`title changed from "${previous.title}" to "${source.title}"`);
	}
	return changes.length > 0 ? `Changed since previous snapshot: ${changes.join(", ")}.` : "Page hash changed.";
}

function valueForField(snapshot: BrowserSnapshot, field: BrowserSnapshotField): unknown {
	switch (field) {
		case "text":
			return snapshot.extracted.text;
		case "html":
			return snapshot.extracted.html;
		case "links":
			return snapshot.extracted.links;
		case "forms":
			return snapshot.extracted.forms;
		case "tables":
			return snapshot.extracted.tables;
		case "interactive":
			return combineActionableItems(snapshot.extracted);
		case "raw":
			return snapshot.raw;
	}
}

function isJsonContainerText(key: string, value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (key !== "text" && key !== "stdout" && key !== "content") return false;
	const trimmed = value.trim();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function buildActionableSummary(extracted: BrowserSnapshotExtracted): string | undefined {
	const items = combineActionableItems(extracted);
	if (!items.length) return undefined;
	return `Actionable elements: ${summarizeArray(items, ACTIONABLE_SUMMARY_LIMIT)}`;
}

function combineActionableItems(extracted: BrowserSnapshotExtracted): unknown[] {
	const items: unknown[] = [];
	for (const source of [extracted.interactive, extracted.elements, extracted.buttons]) {
		if (!source?.length) continue;
		items.push(...source);
	}
	return dedupeActionableItems(items);
}

function dedupeActionableItems(items: unknown[]): unknown[] {
	const seen = new Set<string>();
	const unique: unknown[] = [];
	for (const item of items) {
		const key = stableHash(summarizeActionableItem(item));
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(item);
	}
	return unique;
}

function limitField(value: unknown, maxTextLength: number): { value: unknown; truncated: boolean } {
	if (typeof value === "string") {
		if (value.length <= maxTextLength) return { value, truncated: false };
		return {
			value: `${value.slice(0, maxTextLength)}\n\n[truncated ${value.length - maxTextLength} characters]`,
			truncated: true,
		};
	}
	if (Array.isArray(value)) {
		if (value.length <= ARRAY_SUMMARY_LIMIT) return { value, truncated: false };
		return {
			value: [...value.slice(0, ARRAY_SUMMARY_LIMIT), { omittedItems: value.length - ARRAY_SUMMARY_LIMIT }],
			truncated: true,
		};
	}
	return { value, truncated: false };
}

function summarizeArray(value: unknown[], limit: number): string {
	const sample = value.slice(0, limit).map((item) => summarizeActionableItem(item));
	const omitted = value.length > limit ? `; omitted ${value.length - limit}` : "";
	return `${sample.join(" | ")}${omitted}`;
}

function summarizeActionableItem(item: unknown): string {
	if (typeof item !== "object" || item === null) return compactWhitespace(String(item)).slice(0, 220);
	const record = item as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of [
		"index",
		"id",
		"nodeId",
		"selector",
		"role",
		"type",
		"name",
		"text",
		"label",
		"title",
		"ariaLabel",
		"placeholder",
		"value",
		"href",
		"disabled",
		"visible",
	] as const) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			parts.push(`${key}=${compactWhitespace(value).slice(0, 80)}`);
		} else if (typeof value === "number" || typeof value === "boolean") {
			parts.push(`${key}=${String(value)}`);
		}
	}
	if (parts.length > 0) return parts.join(" ");
	return compactWhitespace(safeStringify(item)).slice(0, 220);
}

function omittedFields(extracted: BrowserSnapshotExtracted): BrowserSnapshotField[] {
	const fields: BrowserSnapshotField[] = [];
	if (extracted.text) fields.push("text");
	if (extracted.html) fields.push("html");
	if (extracted.links?.length) fields.push("links");
	if (extracted.forms?.length) fields.push("forms");
	if (extracted.tables?.length) fields.push("tables");
	if (extracted.interactive?.length) fields.push("interactive");
	if (extracted.elements?.length) fields.push("interactive");
	if (extracted.buttons?.length) fields.push("interactive");
	return fields;
}

function snapshotPageKey(source: BrowserSnapshotSource, extracted: BrowserSnapshotExtracted): string {
	return (
		source.url ?? source.title ?? stableHash({ action: source.action, text: extracted.text, stdout: source.stdout })
	);
}

function stableHash(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	return `{${Object.entries(value)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
		.join(",")}}`;
}

function parseJson(text: string | undefined): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function compactWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function formatDelta(value: number): string {
	return value > 0 ? `+${value}` : String(value);
}

function normalizeTextLimit(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(500, Math.min(100000, Math.floor(value)));
}
