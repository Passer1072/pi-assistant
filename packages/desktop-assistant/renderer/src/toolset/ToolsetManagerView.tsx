import type React from "react";
import { ArrowLeft, Check, FilePenLine, Loader2, Minus, RefreshCw, X } from "lucide-react";
import { Fragment, useState } from "react";
import type { DesktopAssistantSnapshot, DesktopCapabilityId, SkillFileView } from "../../../src/shared/types.ts";
import { persistSettings } from "../app-storage.ts";
import { TOOLSET_CATALOG } from "./toolset-catalog.ts";

export function ToolsetManagerView({
	snapshot,
	onBack,
	onSnapshot,
	windowed = false,
}: {
	snapshot: DesktopAssistantSnapshot;
	onBack: () => void;
	onSnapshot: (snapshot: DesktopAssistantSnapshot) => void;
	windowed?: boolean;
}) {
	const [selectedId, setSelectedId] = useState<DesktopCapabilityId>(TOOLSET_CATALOG[0].id);
	const [busy, setBusy] = useState(false);
	const [statusText, setStatusText] = useState("");
	const [skillFile, setSkillFile] = useState<SkillFileView | undefined>();
	const [skillDraft, setSkillDraft] = useState("");
	const [skillBusy, setSkillBusy] = useState(false);
	const [skillStatus, setSkillStatus] = useState("");

	const capabilities = snapshot.settings.capabilities;
	const selected = TOOLSET_CATALOG.find((item) => item.id === selectedId) ?? TOOLSET_CATALOG[0];
	const selectedSettings = capabilities[selected.id];

	const updateCapability = async (id: DesktopCapabilityId, update: Partial<(typeof capabilities)[DesktopCapabilityId]>) => {
		if (!window.desktopAssistant) return;
		setBusy(true);
		setStatusText("");
		try {
			const next = await window.desktopAssistant.updateSettings({
				capabilities: {
					...capabilities,
					[id]: { ...capabilities[id], ...update },
				},
			});
			onSnapshot(next);
			persistSettings(next.settings);
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const selectCapability = (id: DesktopCapabilityId) => {
		setSelectedId(id);
		setSkillFile(undefined);
		setSkillDraft("");
		setSkillStatus("");
		setStatusText("");
	};

	const openSkillFile = async (id: DesktopCapabilityId) => {
		if (!window.desktopAssistant) return;
		setSkillBusy(true);
		setSkillStatus("");
		try {
			const next = await window.desktopAssistant.getSkillFile({ capabilityId: id });
			setSkillFile(next);
			setSkillDraft(next.content);
		} catch (error) {
			setSkillStatus(error instanceof Error ? error.message : String(error));
		} finally {
			setSkillBusy(false);
		}
	};

	const saveSkillFile = async () => {
		if (!window.desktopAssistant || !skillFile) return;
		setSkillBusy(true);
		setSkillStatus("");
		try {
			const next = await window.desktopAssistant.updateSkillFile({
				capabilityId: skillFile.capabilityId,
				content: skillDraft,
			});
			setSkillFile(next);
			setSkillDraft(next.content);
			setSkillStatus("Skill 已保存，下一次请求会使用新内容。");
		} catch (error) {
			setSkillStatus(error instanceof Error ? error.message : String(error));
		} finally {
			setSkillBusy(false);
		}
	};

	const SelectedIcon = selected.icon;
	const enabledCount = TOOLSET_CATALOG.filter((item) => capabilities[item.id]?.enabled).length;

	return (
		<div className={`screen settings-screen mcp-manager-screen toolset-screen ${windowed ? "windowed" : ""}`}>
			<div className="titlebar" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
				<button
					className="title-btn"
					onClick={onBack}
					type="button"
					aria-label={windowed ? "关闭工具集" : "返回设置"}
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					{windowed ? <X size={16} /> : <ArrowLeft size={16} />}
				</button>
				<div className="title-label">工具集 / Toolset</div>
				<div className="title-window-controls" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
					<button className="title-btn" onClick={() => window.desktopAssistant?.minimizeWindow?.()} type="button" aria-label="最小化">
						<Minus size={14} />
					</button>
					<button className="title-btn danger" onClick={() => window.desktopAssistant?.closeWindow?.()} type="button" aria-label="关闭">
						<X size={14} />
					</button>
				</div>
			</div>
			<div className="settings-scroll mcp-manager-scroll">
				<section className="set-section">
					<div className="mcp-header-row">
						<div>
							<h3>工具集 / Toolset</h3>
							<p className="set-hint">
								按能力分组管理 AI 可以调用的内置工具。开启一组能力后，下方列出的工具才会暴露给模型；这里还能查看每个工具的用途并编辑对应的 skill。
							</p>
						</div>
						<span className="mcp-state connected">{enabledCount}/{TOOLSET_CATALOG.length} 已启用</span>
					</div>
				</section>

				<div className="mcp-layout">
					<section className="set-section mcp-server-list">
						<div className="mcp-section-title">
							<h3>能力 / Capabilities</h3>
						</div>
						{TOOLSET_CATALOG.map((capability) => {
							const settings = capabilities[capability.id];
							const Icon = capability.icon;
							return (
								<button
									type="button"
									key={capability.id}
									className={`toolset-cap-item ${capability.id === selectedId ? "active" : ""}`}
									onClick={() => selectCapability(capability.id)}
								>
									<span className="toolset-cap-icon">
										<Icon size={15} />
									</span>
									<div className="toolset-cap-text">
										<strong>{capability.title}</strong>
										<small>{capability.tools.length} 个工具</small>
									</div>
									<span className={`toolset-state ${settings?.enabled ? "on" : "off"}`}>
										{settings?.enabled ? "启用" : "关闭"}
									</span>
								</button>
							);
						})}
					</section>

					<section className="set-section mcp-editor toolset-detail">
						<div className="toolset-detail-head">
							<span className="toolset-cap-icon lg">
								<SelectedIcon size={18} />
							</span>
							<div className="toolset-detail-title">
								<strong>{selected.title}</strong>
								<small>{selected.subtitle}</small>
							</div>
							<button
								type="button"
								className={`toggle ${selectedSettings.enabled ? "on" : ""}`}
								onClick={() => void updateCapability(selected.id, { enabled: !selectedSettings.enabled })}
								aria-pressed={selectedSettings.enabled}
								disabled={busy}
							>
								<span className="toggle-thumb" />
							</button>
						</div>
						<p className="toolset-detail-desc">{selected.description}</p>

						<div className="toolset-toggle-grid">
							<label className="set-row toggle-row">
								<span>启用 / Enabled</span>
								<button
									type="button"
									className={`toggle ${selectedSettings.enabled ? "on" : ""}`}
									onClick={() => void updateCapability(selected.id, { enabled: !selectedSettings.enabled })}
									aria-pressed={selectedSettings.enabled}
									disabled={busy}
								>
									<span className="toggle-thumb" />
								</button>
							</label>
							<label className="set-row toggle-row">
								<span>命令优先</span>
								<button
									type="button"
									className={`toggle ${selectedSettings.commandFirst ? "on" : ""}`}
									onClick={() => {
										if (!selected.commandFirstLocked) {
											void updateCapability(selected.id, { commandFirst: !selectedSettings.commandFirst });
										}
									}}
									aria-pressed={selectedSettings.commandFirst}
									disabled={busy || selected.commandFirstLocked}
									title={selected.commandFirstNote}
								>
									<span className="toggle-thumb" />
								</button>
							</label>
						</div>
						<p className="set-hint toolset-cmd-note">{selected.commandFirstNote}</p>
						{statusText ? <div className="skill-editor-status">{statusText}</div> : null}

						<div className="toolset-tools-head">
							<h3>包含的工具 / Tools</h3>
							<span className="mcp-badge">{selected.tools.length}</span>
						</div>
						<div className={`toolset-tool-list ${selectedSettings.enabled ? "" : "muted"}`}>
							{selected.tools.map((tool, index) => {
								const showGroup = tool.group && tool.group !== selected.tools[index - 1]?.group;
								return (
									<Fragment key={tool.name}>
										{showGroup ? <div className="toolset-tool-group">{tool.group}</div> : null}
										<div className="toolset-tool-card">
											<div className="toolset-tool-top">
												<strong>{tool.title}</strong>
												<code>{tool.name}</code>
											</div>
											<p>{tool.description}</p>
										</div>
									</Fragment>
								);
							})}
						</div>

						<div className="toolset-skill-head">
							<div>
								<h3>Skill</h3>
								<p className="set-hint">编辑这组能力的引导说明（skill），保存后下一次请求即生效。</p>
							</div>
							<button type="button" className="skill-edit-btn" onClick={() => void openSkillFile(selected.id)} disabled={skillBusy}>
								<FilePenLine size={12} />
								编辑 skill
							</button>
						</div>
						{skillFile && skillFile.capabilityId === selected.id ? (
							<div className="skill-editor">
								<div className="skill-editor-head">
									<div>
										<strong>{selected.title} skill</strong>
										<small>{skillFile.path}</small>
									</div>
									<div className="skill-editor-actions">
										<button type="button" className="ghost-btn wide" onClick={() => void openSkillFile(selected.id)} disabled={skillBusy}>
											刷新
										</button>
										<button type="button" className="primary-btn" onClick={saveSkillFile} disabled={skillBusy || skillDraft === skillFile.content}>
											{skillBusy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
											<span>保存</span>
										</button>
									</div>
								</div>
								<textarea
									className="skill-editor-textarea"
									value={skillDraft}
									onChange={(event) => setSkillDraft(event.target.value)}
									spellCheck={false}
								/>
								{skillStatus ? <div className="skill-editor-status">{skillStatus}</div> : null}
							</div>
						) : skillStatus ? (
							<div className="skill-editor-status">{skillStatus}</div>
						) : null}
					</section>
				</div>
			</div>
		</div>
	);
}
