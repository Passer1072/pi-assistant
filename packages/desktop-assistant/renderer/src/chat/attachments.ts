import type { PendingPromptAttachment, PromptAttachmentKind } from "../../../src/shared/types.ts";

/** Classify an attachment by filename/extension (and mime type when available). */
export function inferAttachmentKind(name: string, mimeType?: string): PromptAttachmentKind {
	const lowerName = name.toLowerCase();
	if (lowerName.endsWith(".docx") || lowerName.endsWith(".doc")) return "word";
	if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls") || lowerName.endsWith(".xlsm")) return "excel";
	if (lowerName.endsWith(".pptx") || lowerName.endsWith(".ppt")) return "powerpoint";
	if (lowerName.endsWith(".pdf")) return "pdf";
	if (mimeType?.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return "image";
	if (
		mimeType?.startsWith("text/") ||
		/\.(txt|md|markdown|json|jsonl|csv|tsv|log|xml|html?|css|jsx?|tsx?|py|ps1|ya?ml|toml|ini)$/i.test(name)
	) {
		return "text";
	}
	return "unknown";
}

export function formatAttachmentSize(sizeBytes: number): string {
	if (sizeBytes < 1024) return `${sizeBytes} B`;
	if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
	return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Build pending attachments from dropped/pasted File objects (needs the real OS path). */
export function attachmentsFromFiles(files: Iterable<File>): PendingPromptAttachment[] {
	const attachments: PendingPromptAttachment[] = [];
	for (const file of files) {
		const path = window.desktopAssistant?.getPathForFile(file);
		if (!path) continue;
		attachments.push({
			id: crypto.randomUUID(),
			name: file.name,
			path,
			sizeBytes: file.size,
			mimeType: file.type || undefined,
			kind: inferAttachmentKind(file.name, file.type || undefined),
		});
	}
	return attachments;
}

/** Treat pasted absolute Windows/UNC file paths (one per line) as attachments. */
export function attachmentsFromText(text: string): PendingPromptAttachment[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^[a-z]:\\.+\.[^\\/:*?"<>|]+$/i.test(line) || /^\\\\[^\\]+\\.+/i.test(line))
		.map((path) => ({
			id: crypto.randomUUID(),
			name: path.split(/[\\/]/).pop() ?? path,
			path,
			sizeBytes: 0,
			kind: inferAttachmentKind(path),
		}));
}
