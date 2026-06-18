import type React from "react";
import { ArrowLeft, Check, Loader2, Minus, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
	PersonalSkillEntry,
	PersonalSkillFileView,
	PersonalSkillListResponse,
} from "../../../src/shared/types.ts";

const EMPTY_CONTENT = [
	"# 用途",
	"",
	"# 适用场景",
	"",
	"# 操作流程",
	"",
	"# 验证方式",
	"",
	"# 注意事项",
].join("\n");

export function PersonalSkillManagerView({ windowed = false }: { windowed?: boolean }) {
	const [list, setList] = useState<PersonalSkillListResponse | undefined>();
	const [selected, setSelected] = useState<PersonalSkillFileView | undefined>();
	const [query, setQuery] = useState("");
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [tagsText, setTagsText] = useState("");
	const [content, setContent] = useState(EMPTY_CONTENT);
	const [busy, setBusy] = useState(false);
	const [statusText, setStatusText] = useState("");

	const load = async () => {
		if (!window.desktopAssistant) return;
		setBusy(true);
		setStatusText("");
		try {
			const next = query.trim()
				? await window.desktopAssistant.searchPersonalSkills({ query, limit: 20 })
				: await window.desktopAssistant.listPersonalSkills();
			setList(next);
			if (!selected && next.skills[0]) {
				await selectSkill(next.skills[0]);
			}
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	useEffect(() => {
		void load();
	}, []);

	const skills = list?.skills ?? [];
	const hasChanges = useMemo(() => {
		if (!selected) return Boolean(title.trim() || description.trim() || content !== EMPTY_CONTENT || tagsText.trim());
		return (
			title !== selected.title ||
			description !== selected.description ||
			tagsText !== selected.tags.join(", ") ||
			content !== selected.content
		);
	}, [content, description, selected, tagsText, title]);

	const selectSkill = async (entry: PersonalSkillEntry) => {
		if (!window.desktopAssistant) return;
		setBusy(true);
		setStatusText("");
		try {
			const view = await window.desktopAssistant.readPersonalSkill({ id: entry.id });
			setSelected(view);
			setTitle(view.title);
			setDescription(view.description);
			setTagsText(view.tags.join(", "));
			setContent(view.content);
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const createNew = () => {
		setSelected(undefined);
		setTitle("");
		setDescription("");
		setTagsText("");
		setContent(EMPTY_CONTENT);
		setStatusText("");
	};

	const save = async () => {
		if (!window.desktopAssistant || !title.trim() || !description.trim()) return;
		setBusy(true);
		setStatusText("");
		try {
			const view = await window.desktopAssistant.savePersonalSkill({
				id: selected?.id,
				title: title.trim(),
				description: description.trim(),
				tags: splitTags(tagsText),
				content,
				overwrite: Boolean(selected),
			});
			setSelected(view);
			setTitle(view.title);
			setDescription(view.description);
			setTagsText(view.tags.join(", "));
			setContent(view.content);
			setList(await window.desktopAssistant.listPersonalSkills());
			setStatusText("个人 skill 已保存。");
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const archive = async () => {
		if (!window.desktopAssistant || !selected) return;
		if (!window.confirm(`归档个人 skill：${selected.title}？`)) return;
		setBusy(true);
		setStatusText("");
		try {
			const next = await window.desktopAssistant.archivePersonalSkill({ id: selected.id });
			setList(next);
			setSelected(undefined);
			createNew();
			setStatusText("个人 skill 已归档。");
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className={`screen settings-screen personal-skill-manager-screen ${windowed ? "windowed" : ""}`}>
			<div className="titlebar" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
				<button
					className="title-btn"
					onClick={() => window.desktopAssistant?.closeWindow?.()}
					type="button"
					aria-label={windowed ? "关闭个人 Skill 仓库" : "返回"}
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					{windowed ? <X size={16} /> : <ArrowLeft size={16} />}
				</button>
				<div className="title-label">个人 Skill 仓库 / Personal Skills</div>
				<div className="title-window-controls" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
					<button className="title-btn" onClick={() => window.desktopAssistant?.minimizeWindow?.()} type="button" aria-label="最小化">
						<Minus size={14} />
					</button>
					<button className="title-btn danger" onClick={() => window.desktopAssistant?.closeWindow?.()} type="button" aria-label="关闭">
						<X size={14} />
					</button>
				</div>
			</div>
			<div className="settings-scroll personal-skill-scroll">
				<section className="set-section">
					<div className="mcp-header-row">
						<div>
							<h3>个人定制 Skill</h3>
							<p className="set-hint">
								仅保存个人流程、交接文档和任务经验。AI 只能维护这里的内容，不能维护系统自带 skill。
							</p>
						</div>
						<button type="button" className="ghost-btn wide" onClick={() => void load()} disabled={busy}>
							{busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
							<span>刷新</span>
						</button>
					</div>
					<p className="set-hint">目录：{list?.rootDir ?? "data/personal-skills"}</p>
				</section>
				<div className="mcp-layout personal-skill-layout">
					<section className="set-section mcp-server-list personal-skill-list">
						<div className="mcp-section-title">
							<h3>条目</h3>
							<button type="button" className="ghost-btn wide" onClick={createNew}>
								<Plus size={14} />
								<span>新建</span>
							</button>
						</div>
						<div className="key-input-row">
							<input
								type="search"
								value={query}
								placeholder="搜索标题、标签或 id"
								onChange={(event) => setQuery(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") void load();
								}}
							/>
							<button type="button" className="ghost-btn" onClick={() => void load()} title="搜索">
								<RefreshCw size={14} />
							</button>
						</div>
						{skills.length ? (
							skills.map((entry) => {
								const visibleTags = entry.tags.slice(0, 3);
								const hiddenTagCount = Math.max(0, entry.tags.length - visibleTags.length);
								const summary = entry.description.trim() || entry.preview.trim() || "暂无描述";
								return (
									<button
										type="button"
										key={entry.id}
										className={`personal-skill-item ${selected?.id === entry.id ? "active" : ""}`}
										onClick={() => void selectSkill(entry)}
									>
										<div className="personal-skill-item-head">
											<strong className="personal-skill-item-title">{entry.title || entry.id}</strong>
											{entry.archived ? <span className="personal-skill-item-badge">archived</span> : null}
										</div>
										<p className="personal-skill-item-description">{summary}</p>
										<div className="personal-skill-item-tags" aria-label="个人 skill 标签">
											{visibleTags.length ? (
												visibleTags.map((tag) => (
													<span className="personal-skill-item-tag" key={tag} title={tag}>
														{tag}
													</span>
												))
											) : (
												<span className="personal-skill-item-tag muted">untagged</span>
											)}
											{hiddenTagCount ? <span className="personal-skill-item-tag muted">+{hiddenTagCount}</span> : null}
										</div>
										<div className="personal-skill-item-meta">
											<span title={entry.id}>{entry.id}</span>
											<span>更新 {formatSkillDate(entry.updatedAt)}</span>
										</div>
									</button>
								);
							})
						) : (
							<p className="set-hint">暂无个人 skill。</p>
						)}
					</section>
					<section className="set-section mcp-editor personal-skill-editor">
						<div className="mcp-section-title">
							<h3>{selected ? "编辑个人 Skill" : "新建个人 Skill"}</h3>
							{selected ? <span className="mcp-badge">personal</span> : null}
						</div>
						<label className="set-row">
							<span>标题</span>
							<input type="text" value={title} onChange={(event) => setTitle(event.target.value)} />
						</label>
						<label className="set-row">
							<span>描述</span>
							<input
								type="text"
								value={description}
								onChange={(event) => setDescription(event.target.value)}
							/>
						</label>
						<label className="set-row">
							<span>标签</span>
							<input
								type="text"
								placeholder="automation, office, music"
								value={tagsText}
								onChange={(event) => setTagsText(event.target.value)}
							/>
						</label>
						{selected ? (
							<p className="set-hint">
								ID: {selected.id}
								<br />
								路径：{selected.path}
							</p>
						) : null}
						<label className="set-row mcp-textarea-row personal-skill-content-row">
							<span>内容</span>
							<textarea value={content} onChange={(event) => setContent(event.target.value)} />
						</label>
						<div className="mcp-editor-actions">
							<button
								type="button"
								className="primary-btn"
								onClick={() => void save()}
								disabled={busy || !title.trim() || !description.trim() || !hasChanges}
							>
								{busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
								<span>保存</span>
							</button>
							<button type="button" className="danger-btn" onClick={() => void archive()} disabled={busy || !selected}>
								<Trash2 size={13} />
								<span>归档</span>
							</button>
						</div>
						{statusText ? <div className="skill-editor-status">{statusText}</div> : null}
					</section>
				</div>
			</div>
		</div>
	);
}

function splitTags(text: string): string[] {
	return text
		.split(/[,\n]/g)
		.map((tag) => tag.trim())
		.filter(Boolean);
}

function formatSkillDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value || "unknown";
	return new Intl.DateTimeFormat("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}
