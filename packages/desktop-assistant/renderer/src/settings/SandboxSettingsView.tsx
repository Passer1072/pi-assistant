import type React from "react";
import { Loader2, Minus, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
	type DesktopAssistantSnapshot,
	type SandboxPhase,
	SANDBOX_PRESETS,
	type SandboxSettings,
	type SandboxStatus,
} from "../../../src/shared/types.ts";

function describeSandboxPhase(phase?: SandboxPhase): string {
	switch (phase) {
		case "ready":
			return "就绪";
		case "initializing":
			return "初始化中";
		case "failed":
			return "初始化失败";
		case "stuck":
			return "卡住";
		case "uninitialized":
			return "未初始化";
		default:
			return "未知";
	}
}

function toggleRow(label: string, value: boolean, onChange: (value: boolean) => void) {
	return (
		<label className="set-row toggle-row">
			<span>{label}</span>
			<button
				type="button"
				className={`toggle ${value ? "on" : ""}`}
				onClick={() => onChange(!value)}
				aria-pressed={value}
			>
				<span className="toggle-thumb" />
			</button>
		</label>
	);
}

function listRow(label: string, values: string[], onChange: (lines: string[]) => void) {
	return (
		<label className="set-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
			<span>{label}</span>
			<textarea
				className="set-textarea"
				rows={Math.min(8, Math.max(2, values.length + 1))}
				value={values.join("\n")}
				spellCheck={false}
				onChange={(event) => onChange(event.target.value.split("\n"))}
			/>
		</label>
	);
}

/**
 * Self-contained sandbox configuration, shown in its own window (like the MCP
 * Manager / Service Log windows). Loads the current sandbox settings from the
 * snapshot, edits a local draft, and applies via updateSettings directly.
 */
export function SandboxSettingsView({
	snapshot,
	onBack,
	onSnapshot,
	windowed = false,
}: {
	snapshot: DesktopAssistantSnapshot | undefined;
	onBack: () => void;
	onSnapshot: (snapshot: DesktopAssistantSnapshot) => void;
	windowed?: boolean;
}) {
	const [draft, setDraft] = useState<SandboxSettings | undefined>(snapshot?.settings.sandbox);
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [actionText, setActionText] = useState("");
	const [applying, setApplying] = useState(false);

	const status: SandboxStatus | undefined = snapshot?.sandboxStatus;

	// Keep the draft synced to the live settings until the user starts editing.
	useEffect(() => {
		if (!dirty && snapshot?.settings.sandbox) setDraft(snapshot.settings.sandbox);
	}, [snapshot?.settings.sandbox, dirty]);

	useEffect(() => {
		return window.desktopAssistant?.onEvent((event) => {
			if (event.snapshot) onSnapshot(event.snapshot);
		});
	}, [onSnapshot]);

	const patch = (mut: (sandbox: SandboxSettings) => SandboxSettings) => {
		setActionText("");
		setDirty(true);
		setDraft((current) => (current ? mut(current) : current));
	};

	const apply = async () => {
		if (!draft || !window.desktopAssistant) return;
		setApplying(true);
		try {
			const next = await window.desktopAssistant.updateSettings({ settings: { sandbox: draft } });
			if (next) {
				onSnapshot(next);
				setDirty(false);
				setActionText("已应用沙箱设置。");
			}
		} finally {
			setApplying(false);
		}
	};

	const restore = () => {
		if (snapshot?.settings.sandbox) setDraft(snapshot.settings.sandbox);
		setDirty(false);
		setActionText("已恢复到当前已应用设置。");
	};

	const s = draft;

	return (
		<div className={`screen settings-screen sandbox-settings-screen ${windowed ? "windowed" : ""}`}>
			<div className="titlebar" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
				<button
					className="title-btn"
					onClick={onBack}
					type="button"
					aria-label="关闭沙箱设置"
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					<X size={16} />
				</button>
				<div className="title-label">沙箱设置 / Sandbox</div>
				<div className="title-window-controls" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
					<button className="title-btn" onClick={() => window.desktopAssistant?.minimizeWindow?.()} type="button" aria-label="最小化">
						<Minus size={14} />
					</button>
					<button className="title-btn danger" onClick={() => window.desktopAssistant?.closeWindow?.()} type="button" aria-label="关闭">
						<X size={14} />
					</button>
				</div>
			</div>

			<div className="settings-scroll sandbox-settings-scroll">
				{!s ? (
					<section className="set-section">
						<p className="set-hint">加载沙箱设置中…</p>
					</section>
				) : (
					<>
						<section className="set-section">
							<p className="set-hint">
								把文档处理、临时文件、试探性命令等中间工作隔离在工作区内；只把最终成果交付真实系统。
							</p>
							{toggleRow("启用沙箱", s.enabled, (value) => patch((sb) => ({ ...sb, enabled: value })))}
							<p className="set-hint">关闭后退回旧的「仅按权限模式确认」行为，不做任何隔离。</p>

							{s.enabled ? (
								<label className="set-row">
									<span>预设</span>
									<select
										value={s.preset}
										onChange={(event) => {
											const value = event.target.value as SandboxSettings["preset"];
											if (value === "custom") {
												patch((sb) => ({ ...sb, preset: "custom" }));
											} else {
												patch((sb) => ({ ...SANDBOX_PRESETS[value](), enabled: sb.enabled }));
											}
										}}
									>
										<option value="strict">严格</option>
										<option value="balanced">均衡</option>
										<option value="permissive">宽松</option>
										<option value="custom">自定义</option>
									</select>
								</label>
							) : null}
						</section>

						{s.enabled ? (
							<>
								<section className="set-section">
									<h3>状态</h3>
									<p className="set-hint">
										{describeSandboxPhase(status?.phase)}
										{status && status.phase === "initializing" ? `（${status.progress}%）` : ""}
										{status ? ` · 用量 ${status.usageMb}MB / ${status.quotaMb}MB` : ""}
									</p>
									{status?.rootDir ? (
										<div className="cache-path-card">
											<span>沙箱目录</span>
											<code>{status.rootDir}</code>
										</div>
									) : null}
									{status?.lastError ? (
										<p className="set-hint" style={{ color: "var(--danger, #e06c75)" }}>
											{status.lastError}
										</p>
									) : null}
									<div className="sandbox-action-row">
										<button
											type="button"
											className="ghost-btn wide"
											disabled={busy}
											onClick={async () => {
												setBusy(true);
												setActionText("正在初始化…");
												try {
													const next = await window.desktopAssistant.initSandbox();
													setActionText(`初始化结果：${describeSandboxPhase(next.phase)}`);
												} finally {
													setBusy(false);
												}
											}}
										>
											立即初始化
										</button>
										<button
											type="button"
											className="ghost-btn wide"
											disabled={busy}
											onClick={async () => {
												setBusy(true);
												setActionText("正在重置…");
												try {
													const next = await window.desktopAssistant.resetSandbox();
													setActionText(`已重置：${describeSandboxPhase(next.phase)}`);
												} finally {
													setBusy(false);
												}
											}}
										>
											重置沙箱
										</button>
										<button
											type="button"
											className="ghost-btn wide"
											disabled={busy}
											onClick={async () => {
												setBusy(true);
												try {
													const res = await window.desktopAssistant.cleanSandbox({ strategy: "oldest" });
													setActionText(`已清理 ${res.removedEntries} 项，释放 ${res.freedMb}MB`);
												} finally {
													setBusy(false);
												}
											}}
										>
											清理空间
										</button>
										<button
											type="button"
											className="ghost-btn wide"
											onClick={() => window.desktopAssistant.openSandboxFolder()}
										>
											打开沙箱目录
										</button>
									</div>
									{actionText ? <p className="set-hint">{actionText}</p> : null}
								</section>

								<section className="set-section">
									<h3>工作区</h3>
									<label className="set-row">
										<span>存储位置</span>
										<input
											type="text"
											placeholder="留空使用默认 (userData/sandbox)"
											value={s.workspace.rootDir ?? ""}
											onChange={(event) =>
												patch((sb) => ({
													...sb,
													preset: "custom",
													workspace: { ...sb.workspace, rootDir: event.target.value || undefined },
												}))
											}
										/>
									</label>
									<label className="set-row">
										<span>存储额度 (MB)</span>
										<input
											type="number"
											min={64}
											value={s.workspace.quotaMb}
											onChange={(event) =>
												patch((sb) => ({
													...sb,
													preset: "custom",
													workspace: { ...sb.workspace, quotaMb: Number(event.target.value) || sb.workspace.quotaMb },
												}))
											}
										/>
									</label>
									<label className="set-row">
										<span>超额策略</span>
										<select
											value={s.workspace.overQuotaPolicy}
											onChange={(event) =>
												patch((sb) => ({
													...sb,
													preset: "custom",
													workspace: {
														...sb.workspace,
														overQuotaPolicy: event.target.value as SandboxSettings["workspace"]["overQuotaPolicy"],
													},
												}))
											}
										>
											<option value="auto_clean">自动清理最旧</option>
											<option value="deny_writes">拒绝新写入</option>
											<option value="confirm">弹确认</option>
										</select>
									</label>
									{toggleRow("启动时自动初始化", s.workspace.autoInitOnStartup, (value) =>
										patch((sb) => ({ ...sb, preset: "custom", workspace: { ...sb.workspace, autoInitOnStartup: value } })),
									)}
									{toggleRow("常驻预热进程", s.workspace.keepWarmProcess, (value) =>
										patch((sb) => ({ ...sb, preset: "custom", workspace: { ...sb.workspace, keepWarmProcess: value } })),
									)}
									{toggleRow("会话结束时清空沙箱", s.workspace.cleanOnSessionEnd, (value) =>
										patch((sb) => ({ ...sb, preset: "custom", workspace: { ...sb.workspace, cleanOnSessionEnd: value } })),
									)}
								</section>

								<section className="set-section">
									<h3>文件系统</h3>
									{toggleRow("真实写入仅限允许根目录（关：越界写改为弹确认）", s.filesystem.confineWritesToRoots, (value) =>
										patch((sb) => ({ ...sb, preset: "custom", filesystem: { ...sb.filesystem, confineWritesToRoots: value } })),
									)}
									{toggleRow("拒绝软链接/junction 越界", s.filesystem.denySymlinkEscape, (value) =>
										patch((sb) => ({ ...sb, preset: "custom", filesystem: { ...sb.filesystem, denySymlinkEscape: value } })),
									)}
									{listRow("可写根目录", s.filesystem.writeRoots, (lines) =>
										patch((sb) => ({ ...sb, preset: "custom", filesystem: { ...sb.filesystem, writeRoots: lines } })),
									)}
									{listRow("可读根目录", s.filesystem.readRoots, (lines) =>
										patch((sb) => ({ ...sb, preset: "custom", filesystem: { ...sb.filesystem, readRoots: lines } })),
									)}
									{listRow("受保护路径（永远拒绝）", s.filesystem.protectedPaths, (lines) =>
										patch((sb) => ({ ...sb, preset: "custom", filesystem: { ...sb.filesystem, protectedPaths: lines } })),
									)}
								</section>

								<section className="set-section">
									<h3>命令</h3>
									{toggleRow("拦截网络下载到磁盘", s.commands.blockNetworkDownload, (value) =>
										patch((sb) => ({ ...sb, preset: "custom", commands: { ...sb.commands, blockNetworkDownload: value } })),
									)}
									{listRow("危险命令黑名单（正则，每行一条）", s.commands.denyPatterns, (lines) =>
										patch((sb) => ({ ...sb, preset: "custom", commands: { ...sb.commands, denyPatterns: lines } })),
									)}
									{listRow("安全命令白名单（正则，每行一条）", s.commands.allowPatterns, (lines) =>
										patch((sb) => ({ ...sb, preset: "custom", commands: { ...sb.commands, allowPatterns: lines } })),
									)}
								</section>

								<section className="set-section">
									<h3>网络</h3>
									{toggleRow("阻止访问内网/本机地址（SSRF 防护）", s.network.blockPrivateIps, (value) =>
										patch((sb) => ({ ...sb, preset: "custom", network: { ...sb.network, blockPrivateIps: value } })),
									)}
									{listRow("域名白名单（每行一个，留空不限制）", s.network.domainAllowList, (lines) =>
										patch((sb) => ({ ...sb, preset: "custom", network: { ...sb.network, domainAllowList: lines } })),
									)}
									{listRow("域名黑名单（每行一个）", s.network.domainDenyList, (lines) =>
										patch((sb) => ({ ...sb, preset: "custom", network: { ...sb.network, domainDenyList: lines } })),
									)}
								</section>

								<section className="set-section">
									<h3>资源上限</h3>
									<label className="set-row">
										<span>命令超时 (ms)</span>
										<input
											type="number"
											min={1000}
											value={s.resourceLimits.commandTimeoutMs}
											onChange={(event) =>
												patch((sb) => ({
													...sb,
													preset: "custom",
													resourceLimits: {
														...sb.resourceLimits,
														commandTimeoutMs: Number(event.target.value) || sb.resourceLimits.commandTimeoutMs,
													},
												}))
											}
										/>
									</label>
									<label className="set-row">
										<span>最大输出字符</span>
										<input
											type="number"
											min={1000}
											value={s.resourceLimits.maxOutputChars}
											onChange={(event) =>
												patch((sb) => ({
													...sb,
													preset: "custom",
													resourceLimits: {
														...sb.resourceLimits,
														maxOutputChars: Number(event.target.value) || sb.resourceLimits.maxOutputChars,
													},
												}))
											}
										/>
									</label>
									<label className="set-row">
										<span>最大并发进程</span>
										<input
											type="number"
											min={1}
											value={s.resourceLimits.maxConcurrentProcesses}
											onChange={(event) =>
												patch((sb) => ({
													...sb,
													preset: "custom",
													resourceLimits: {
														...sb.resourceLimits,
														maxConcurrentProcesses: Number(event.target.value) || sb.resourceLimits.maxConcurrentProcesses,
													},
												}))
											}
										/>
									</label>
									{toggleRow("超时/中止时连子进程一起结束", s.resourceLimits.killProcessTree, (value) =>
										patch((sb) => ({ ...sb, preset: "custom", resourceLimits: { ...sb.resourceLimits, killProcessTree: value } })),
									)}
								</section>

								<section className="set-section">
									<h3>高级 / 审计</h3>
									{toggleRow("以受限用户运行沙箱命令（需预先配置，OS 级写约束）", s.hardening.runAsRestrictedUser, (value) =>
										patch((sb) => ({ ...sb, preset: "custom", hardening: { ...sb.hardening, runAsRestrictedUser: value } })),
									)}
									{toggleRow("记录沙箱裁决审计日志", s.audit.logDecisions, (value) =>
										patch((sb) => ({ ...sb, preset: "custom", audit: { ...sb.audit, logDecisions: value } })),
									)}
								</section>
							</>
						) : null}

						<div className="sandbox-apply-bar">
							<button type="button" className="ghost-btn wide" onClick={restore} disabled={!dirty || applying}>
								恢复
							</button>
							<button type="button" className="primary-btn" onClick={apply} disabled={!dirty || applying}>
								{applying ? <Loader2 size={14} className="spin" /> : null}
								<span>应用</span>
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
