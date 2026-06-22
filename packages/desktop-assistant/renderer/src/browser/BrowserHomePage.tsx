import { Check, Clock, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BrowserHistoryEntry, BrowserShortcut } from "../../../src/shared/types.ts";
import { resolveOmniboxUrl } from "./home-page-url.ts";

interface BrowserHomePageProps {
	shortcuts: BrowserShortcut[];
	recent: BrowserHistoryEntry[];
	searchTemplate: string;
	onNavigate: (url: string) => void;
	onShortcutsChange: (next: BrowserShortcut[]) => void;
}

interface ShortcutDraft {
	id: string | null;
	label: string;
	url: string;
}

export function BrowserHomePage({
	shortcuts,
	recent,
	searchTemplate,
	onNavigate,
	onShortcutsChange,
}: BrowserHomePageProps) {
	const [query, setQuery] = useState("");
	const [draft, setDraft] = useState<ShortcutDraft | null>(null);
	const greeting = useGreeting();

	const submitSearch = (event: React.FormEvent) => {
		event.preventDefault();
		const url = resolveOmniboxUrl(query, searchTemplate);
		if (url) onNavigate(url);
	};

	const saveDraft = () => {
		if (!draft) return;
		const label = draft.label.trim();
		const url = draft.url.trim();
		if (!label || !url) return;
		if (draft.id) {
			onShortcutsChange(shortcuts.map((item) => (item.id === draft.id ? { ...item, label, url } : item)));
		} else {
			onShortcutsChange([...shortcuts, { id: `sc-${Date.now().toString(36)}`, label, url }]);
		}
		setDraft(null);
	};

	const removeShortcut = (id: string) => {
		onShortcutsChange(shortcuts.filter((item) => item.id !== id));
		if (draft?.id === id) setDraft(null);
	};

	return (
		<div className="browser-home">
			<div className="browser-home-inner">
				<div className="browser-home-greeting">
					<Clock size={15} />
					<span>{greeting}</span>
				</div>

				<form className="browser-home-search" onSubmit={submitSearch}>
					<Search size={18} />
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="搜索或输入网址"
						spellCheck={false}
						autoFocus
					/>
					<button type="submit" disabled={!query.trim()}>
						前往
					</button>
				</form>

				<div className="browser-home-section-title">快捷方式</div>
				<div className="browser-shortcut-grid">
					{shortcuts.map((shortcut) => (
						<ShortcutTile
							key={shortcut.id}
							shortcut={shortcut}
							onOpen={() => onNavigate(shortcut.url)}
							onEdit={() => setDraft({ id: shortcut.id, label: shortcut.label, url: shortcut.url })}
							onRemove={() => removeShortcut(shortcut.id)}
						/>
					))}
					<button
						type="button"
						className="browser-shortcut-add"
						onClick={() => setDraft({ id: null, label: "", url: "" })}
						title="添加快捷方式"
					>
						<Plus size={20} />
						<span>添加</span>
					</button>
				</div>

				{recent.length > 0 ? (
					<>
						<div className="browser-home-section-title">最近访问</div>
						<div className="browser-recent-list">
							{recent.map((entry) => (
								<button
									key={entry.url}
									type="button"
									className="browser-recent-item"
									onClick={() => onNavigate(entry.url)}
									title={entry.url}
								>
									<FaviconImage url={entry.url} fallbackUrl={entry.faviconUrl} label={entry.title} size={16} />
									<span className="browser-recent-title">{entry.title || entry.url}</span>
									<span className="browser-recent-host">{safeHost(entry.url)}</span>
								</button>
							))}
						</div>
					</>
				) : null}
			</div>

			{draft ? (
				<ShortcutEditor
					draft={draft}
					onChange={setDraft}
					onSave={saveDraft}
					onCancel={() => setDraft(null)}
				/>
			) : null}
		</div>
	);
}

function ShortcutTile({
	shortcut,
	onOpen,
	onEdit,
	onRemove,
}: {
	shortcut: BrowserShortcut;
	onOpen: () => void;
	onEdit: () => void;
	onRemove: () => void;
}) {
	return (
		<div className="browser-shortcut-tile">
			<button type="button" className="browser-shortcut-main" onClick={onOpen} title={shortcut.url}>
				<FaviconImage url={shortcut.url} fallbackUrl={shortcut.iconUrl} label={shortcut.label} size={24} />
				<span className="browser-shortcut-label">{shortcut.label}</span>
			</button>
			<div className="browser-shortcut-actions">
				<button type="button" onClick={onEdit} title="编辑" aria-label="编辑">
					<Pencil size={12} />
				</button>
				<button type="button" onClick={onRemove} title="删除" aria-label="删除">
					<Trash2 size={12} />
				</button>
			</div>
		</div>
	);
}

function ShortcutEditor({
	draft,
	onChange,
	onSave,
	onCancel,
}: {
	draft: ShortcutDraft;
	onChange: (next: ShortcutDraft) => void;
	onSave: () => void;
	onCancel: () => void;
}) {
	const valid = draft.label.trim().length > 0 && draft.url.trim().length > 0;
	return (
		<div className="browser-shortcut-editor-backdrop" onMouseDown={onCancel}>
			<div
				className="browser-shortcut-editor"
				onMouseDown={(event) => event.stopPropagation()}
				role="dialog"
				aria-label={draft.id ? "编辑快捷方式" : "添加快捷方式"}
			>
				<div className="browser-shortcut-editor-head">
					<span>{draft.id ? "编辑快捷方式" : "添加快捷方式"}</span>
					<button type="button" onClick={onCancel} title="关闭" aria-label="关闭">
						<X size={14} />
					</button>
				</div>
				<label>
					<span>名称</span>
					<input
						value={draft.label}
						onChange={(event) => onChange({ ...draft, label: event.target.value })}
						placeholder="例如：哔哩哔哩"
						autoFocus
					/>
				</label>
				<label>
					<span>链接</span>
					<input
						value={draft.url}
						onChange={(event) => onChange({ ...draft, url: event.target.value })}
						placeholder="example.com 或 https://example.com"
						spellCheck={false}
						onKeyDown={(event) => {
							if (event.key === "Enter" && valid) onSave();
						}}
					/>
				</label>
				<div className="browser-shortcut-editor-actions">
					<button type="button" className="ghost-btn" onClick={onCancel}>
						取消
					</button>
					<button type="button" className="primary-btn" onClick={onSave} disabled={!valid}>
						<Check size={14} />
						<span>保存</span>
					</button>
				</div>
			</div>
		</div>
	);
}

function FaviconImage({
	url,
	fallbackUrl,
	label,
	size,
}: {
	url: string;
	fallbackUrl?: string;
	label: string;
	size: number;
}) {
	const host = useMemo(() => safeHost(url), [url]);
	const sources = useMemo(() => {
		const list: string[] = [];
		if (fallbackUrl) list.push(fallbackUrl);
		if (host) list.push(`https://icons.duckduckgo.com/ip3/${host}.ico`);
		return list;
	}, [fallbackUrl, host]);
	const [sourceIndex, setSourceIndex] = useState(0);
	useEffect(() => setSourceIndex(0), []);

	const src = sources[sourceIndex];
	if (!src) {
		return (
			<span className="browser-favicon-letter" style={{ width: size, height: size, fontSize: size * 0.5 }}>
				{(label.trim()[0] ?? host?.[0] ?? "?").toUpperCase()}
			</span>
		);
	}
	return (
		<img
			className="browser-favicon-img"
			src={src}
			alt=""
			width={size}
			height={size}
			loading="lazy"
			onError={() => setSourceIndex((index) => index + 1)}
		/>
	);
}

function useGreeting(): string {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(new Date()), 30_000);
		return () => window.clearInterval(timer);
	}, []);
	const hour = now.getHours();
	const part = hour < 6 ? "凌晨好" : hour < 12 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
	const time = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
	return `${time} · ${part}`;
}

function safeHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
}
