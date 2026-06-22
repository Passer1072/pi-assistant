import {
	ClipboardCopy,
	Copy,
	File as FileIcon,
	FileArchive,
	FileImage,
	FileSpreadsheet,
	FileText,
	FileVideo,
	Folder,
	FolderOpen,
	Music,
	Presentation,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { FileArtifact } from "../../../src/shared/types.ts";

const EXT_GROUPS: Array<{ icon: ReactNode; exts: string[] }> = [
	{ icon: <FileSpreadsheet size={20} />, exts: ["xlsx", "xls", "xlsm", "csv", "tsv"] },
	{ icon: <FileText size={20} />, exts: ["doc", "docx", "txt", "md", "rtf", "pdf"] },
	{ icon: <Presentation size={20} />, exts: ["ppt", "pptx"] },
	{ icon: <FileImage size={20} />, exts: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"] },
	{ icon: <FileVideo size={20} />, exts: ["mp4", "mov", "avi", "mkv", "webm"] },
	{ icon: <Music size={20} />, exts: ["mp3", "wav", "flac", "m4a", "ogg"] },
	{ icon: <FileArchive size={20} />, exts: ["zip", "rar", "7z", "tar", "gz"] },
];

function iconFor(artifact: FileArtifact): ReactNode {
	if (artifact.isDirectory) return <Folder size={20} />;
	for (const group of EXT_GROUPS) {
		if (group.exts.includes(artifact.ext)) return group.icon;
	}
	return <FileIcon size={20} />;
}

function formatBytes(bytes: number): string {
	if (bytes <= 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatTime(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Containing folder name (the last directory segment of the path). */
function parentFolder(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.length >= 2 ? parts[parts.length - 2] : "";
}

async function copyTextToClipboard(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);
	textarea.select();
	try {
		document.execCommand("copy");
	} finally {
		document.body.removeChild(textarea);
	}
}

interface MenuAction {
	key: string;
	label: string;
	icon: ReactNode;
	run: () => Promise<void> | void;
}

function ArtifactContextMenu({
	x,
	y,
	actions,
	onClose,
}: {
	x: number;
	y: number;
	actions: MenuAction[];
	onClose: () => void;
}) {
	useEffect(() => {
		const close = () => onClose();
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		// Defer so the opening contextmenu/click that spawned us doesn't immediately close it.
		const id = window.setTimeout(() => {
			window.addEventListener("click", close);
			window.addEventListener("contextmenu", close);
			window.addEventListener("resize", close);
			window.addEventListener("blur", close);
		}, 0);
		window.addEventListener("keydown", onKey);
		return () => {
			window.clearTimeout(id);
			window.removeEventListener("click", close);
			window.removeEventListener("contextmenu", close);
			window.removeEventListener("resize", close);
			window.removeEventListener("blur", close);
			window.removeEventListener("keydown", onKey);
		};
	}, [onClose]);

	// Keep the menu within the viewport.
	const width = 180;
	const height = actions.length * 34 + 8;
	const left = Math.min(x, window.innerWidth - width - 8);
	const top = Math.min(y, window.innerHeight - height - 8);

	return createPortal(
		<div className="artifact-menu" style={{ left, top }} role="menu">
			{actions.map((action) => (
				<button
					key={action.key}
					type="button"
					className="artifact-menu-item"
					role="menuitem"
					onClick={() => {
						onClose();
						void action.run();
					}}
				>
					<span className="artifact-menu-icon">{action.icon}</span>
					<span>{action.label}</span>
				</button>
			))}
		</div>,
		document.body,
	);
}

export function FileArtifactCard({ artifact }: { artifact: FileArtifact }) {
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const [flash, setFlash] = useState<string | null>(null);

	function showFlash(text: string) {
		setFlash(text);
		window.setTimeout(() => setFlash((current) => (current === text ? null : current)), 1400);
	}

	async function open() {
		const result = await window.desktopAssistant.openPath({ path: artifact.path });
		if (!result?.ok) showFlash(result?.error ?? "打开失败");
	}

	const actions: MenuAction[] = [
		{ key: "open", label: "打开", icon: <FolderOpen size={14} />, run: open },
		{
			key: "reveal",
			label: "打开文件所在文件夹",
			icon: <Folder size={14} />,
			run: async () => {
				const result = await window.desktopAssistant.showItemInFolder({ path: artifact.path });
				if (!result?.ok) showFlash(result?.error ?? "打开文件夹失败");
			},
		},
		{
			key: "copy-file",
			label: "复制文件",
			icon: <Copy size={14} />,
			run: async () => {
				const result = await window.desktopAssistant.copyFileToClipboard({ path: artifact.path });
				showFlash(result?.ok ? "已复制文件" : (result?.error ?? "复制失败"));
			},
		},
		{
			key: "copy-path",
			label: "复制文件路径",
			icon: <ClipboardCopy size={14} />,
			run: async () => {
				await copyTextToClipboard(artifact.path);
				showFlash("已复制路径");
			},
		},
	];

	const meta = [parentFolder(artifact.path), formatBytes(artifact.sizeBytes), formatTime(artifact.modifiedAt)]
		.filter(Boolean)
		.join(" · ");

	return (
		<div
			className="file-artifact-card"
			role="button"
			tabIndex={0}
			title={artifact.path}
			onDoubleClick={() => void open()}
			onClick={() => void open()}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					void open();
				}
			}}
			onContextMenu={(event) => {
				event.preventDefault();
				setMenu({ x: event.clientX, y: event.clientY });
			}}
		>
			<span className="file-artifact-icon">{iconFor(artifact)}</span>
			<span className="file-artifact-info">
				<span className="file-artifact-name">{artifact.name}</span>
				{meta ? <span className="file-artifact-meta">{flash ?? meta}</span> : null}
			</span>
			{menu ? (
				<ArtifactContextMenu x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} />
			) : null}
		</div>
	);
}

export function FileArtifactList({ artifacts }: { artifacts: FileArtifact[] }) {
	if (!artifacts.length) return null;
	return (
		<div className="file-artifact-list">
			{artifacts.map((artifact) => (
				<FileArtifactCard key={artifact.path} artifact={artifact} />
			))}
		</div>
	);
}
