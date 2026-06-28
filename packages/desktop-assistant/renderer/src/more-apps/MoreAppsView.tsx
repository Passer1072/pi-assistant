import { ArrowLeft, Plus, Power, Settings as SettingsIcon, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
	DesktopAssistantSnapshot,
	ExternalAppConfig,
	MoreAppTerminalLine,
	MoreAppView,
	WakeWordModelMetadata,
	WindowMode,
} from "../../../src/shared/types.ts";
import { TitleBar } from "../components/TitleBar.tsx";

interface MoreAppsViewProps {
	snapshot: DesktopAssistantSnapshot;
	onBack: () => void;
	onMenu: () => void;
	wakeModels: WakeWordModelMetadata[];
	windowMode: WindowMode;
	onToggleWindowMode: () => void;
}

const STATUS_LABEL: Record<MoreAppView["status"], string> = {
	stopped: "未运行",
	starting: "启动中",
	running: "运行中",
	error: "出错",
};

interface ContextMenuState {
	appId: string;
	x: number;
	y: number;
}

export function MoreAppsView({
	snapshot,
	onBack,
	onMenu,
	wakeModels,
	windowMode,
	onToggleWindowMode,
}: MoreAppsViewProps) {
	const api = window.desktopAssistant;
	const screenRef = useRef<HTMLDivElement | null>(null);
	const [apps, setApps] = useState<MoreAppView[]>([]);
	const [terminals, setTerminals] = useState<Record<string, MoreAppTerminalLine[]>>({});
	const [menu, setMenu] = useState<ContextMenuState | null>(null);
	const [settingsAppId, setSettingsAppId] = useState<string | null>(null);
	const [terminalAppId, setTerminalAppId] = useState<string | null>(null);

	useEffect(() => {
		void api.listMoreApps().then(setApps);
		const off = api.onMoreAppEvent((event) => {
			if (event.type === "status") {
				setApps(event.apps);
			} else {
				setTerminals((current) => {
					const existing = current[event.appId] ?? [];
					if (existing.length > 0 && existing[existing.length - 1].seq >= event.line.seq) return current;
					const next = [...existing, event.line];
					if (next.length > 500) next.splice(0, next.length - 500);
					return { ...current, [event.appId]: next };
				});
			}
		});
		return off;
	}, [api]);

	// Dismiss the right-click menu on any outside interaction.
	useEffect(() => {
		if (!menu) return;
		const close = () => setMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("resize", close);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("resize", close);
		};
	}, [menu]);

	const openApp = (appId: string) => void api.openMoreApp(appId).then(setApps);
	const startApp = (appId: string) => void api.startMoreApp(appId).then(setApps);
	const stopApp = (appId: string) => void api.stopMoreApp(appId).then(setApps);

	const openTerminal = (appId: string) => {
		void api.getMoreAppTerminal(appId).then((res) => {
			setTerminals((current) => ({ ...current, [appId]: res.lines }));
			setTerminalAppId(appId);
		});
	};

	const settingsApp = apps.find((app) => app.id === settingsAppId) ?? null;
	const terminalApp = apps.find((app) => app.id === terminalAppId) ?? null;

	return (
		<div className="more-apps-screen" ref={screenRef}>
			<TitleBar
				onMenu={onMenu}
				title="更多应用"
				webSearchMode={snapshot.settings.webSearch?.mode}
				voiceOverlay={snapshot.voiceOverlay}
				voiceSettings={snapshot.settings.voice}
				wakeModels={wakeModels}
				windowMode={windowMode}
				onToggleWindowMode={onToggleWindowMode}
			/>

			<header className="more-apps-head">
				<button className="title-btn" type="button" onClick={onBack} aria-label="返回">
					<ArrowLeft size={16} />
				</button>
				<div className="more-apps-head-title">
					<span className="more-apps-head-name">更多应用</span>
					<span className="more-apps-head-sub">独立窗口运行，可被 AI 调用 · 右键图标查看更多</span>
				</div>
			</header>

			<div className="more-apps-grid">
				{apps.map((app) => (
					<button
						key={app.id}
						type="button"
						className={`more-app-card ${app.status}`}
						onClick={() => openApp(app.id)}
						onContextMenu={(event) => {
							event.preventDefault();
							const rect = screenRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
							setMenu({ appId: app.id, x: event.clientX - rect.left, y: event.clientY - rect.top });
						}}
						title={app.description ?? app.name}
					>
						<span className={`more-app-status-dot ${app.status}`} aria-label={STATUS_LABEL[app.status]} />
						<span className="more-app-icon">{app.icon}</span>
						<span className="more-app-name">{app.name}</span>
						<span className="more-app-tags">
							{app.aiEnabled ? <span className="more-app-tag ai">AI</span> : null}
							{app.autoStart ? <span className="more-app-tag auto">自启</span> : null}
							{app.idleTimeoutMinutes ? <span className="more-app-tag idle">{app.idleTimeoutMinutes}m</span> : null}
						</span>
					</button>
				))}

				<button type="button" className="more-app-card add-tile" disabled title="敬请期待：截取桌面图标添加应用">
					<span className="more-app-icon">
						<Plus size={26} />
					</span>
					<span className="more-app-name">添加应用</span>
				</button>
			</div>

			{menu ? (
				<MoreAppContextMenu
					app={apps.find((app) => app.id === menu.appId)}
					x={menu.x}
					y={menu.y}
					onSettings={() => {
						setSettingsAppId(menu.appId);
						setMenu(null);
					}}
					onTerminal={() => {
						openTerminal(menu.appId);
						setMenu(null);
					}}
					onToggleRun={() => {
						const app = apps.find((entry) => entry.id === menu.appId);
						if (app && (app.status === "running" || app.status === "starting")) stopApp(menu.appId);
						else startApp(menu.appId);
						setMenu(null);
					}}
				/>
			) : null}

			{settingsApp ? (
				<AppSettingsModal
					app={settingsApp}
					onClose={() => setSettingsAppId(null)}
					onSave={(config) => {
						void api.updateMoreAppConfig(settingsApp.id, config).then(setApps);
						setSettingsAppId(null);
					}}
				/>
			) : null}

			{terminalApp ? (
				<AppTerminalPanel
					app={terminalApp}
					lines={terminals[terminalApp.id] ?? []}
					onClose={() => setTerminalAppId(null)}
				/>
			) : null}
		</div>
	);
}

function MoreAppContextMenu({
	app,
	x,
	y,
	onSettings,
	onTerminal,
	onToggleRun,
}: {
	app?: MoreAppView;
	x: number;
	y: number;
	onSettings: () => void;
	onTerminal: () => void;
	onToggleRun: () => void;
}) {
	const running = app?.status === "running" || app?.status === "starting";
	return (
		<div className="more-app-menu" style={{ left: x, top: y }} onClick={(event) => event.stopPropagation()}>
			<button type="button" className="more-app-menu-item" onClick={onSettings}>
				<SettingsIcon size={14} />
				<span>设置</span>
			</button>
			<button type="button" className="more-app-menu-item" onClick={onTerminal}>
				<SquareTerminal size={14} />
				<span>显示软件终端</span>
			</button>
			<button type="button" className="more-app-menu-item" onClick={onToggleRun}>
				<Power size={14} />
				<span>{running ? "关闭" : "启动"}</span>
			</button>
		</div>
	);
}

function AppSettingsModal({
	app,
	onClose,
	onSave,
}: {
	app: MoreAppView;
	onClose: () => void;
	onSave: (config: ExternalAppConfig) => void;
}) {
	const [autoStart, setAutoStart] = useState(app.autoStart);
	const [port, setPort] = useState(app.port ? String(app.port) : "");
	const [idleTimeout, setIdleTimeout] = useState(
		app.idleTimeoutMinutes ? String(app.idleTimeoutMinutes) : "",
	);

	const save = () => {
		const parsedPort = port.trim() ? Number.parseInt(port.trim(), 10) : undefined;
		const parsedIdle = idleTimeout.trim() ? Number.parseInt(idleTimeout.trim(), 10) : undefined;
		onSave({
			autoStart,
			port: Number.isFinite(parsedPort) ? parsedPort : undefined,
			idleTimeoutMinutes: Number.isFinite(parsedIdle) && (parsedIdle ?? 0) > 0 ? parsedIdle : 0,
		});
	};

	return (
		<div className="more-app-modal-scrim" onClick={onClose}>
			<div className="more-app-modal" onClick={(event) => event.stopPropagation()}>
				<div className="more-app-modal-head">
					<span>
						{app.icon} {app.name} · 设置
					</span>
					<button type="button" className="title-btn" onClick={onClose} aria-label="关闭">
						<X size={16} />
					</button>
				</div>
				<label className="more-app-field-row">
					<input type="checkbox" checked={autoStart} onChange={(event) => setAutoStart(event.target.checked)} />
					<span>随 AI 桌面助手启动而自动启动</span>
				</label>
				<label className="more-app-field">
					<span>端口（留空使用默认）</span>
					<input
						type="number"
						value={port}
						placeholder="自动分配"
						onChange={(event) => setPort(event.target.value)}
					/>
				</label>
				<label className="more-app-field">
					<span>空闲自动关闭（分钟，0 或留空表示不自动关闭）</span>
					<input
						type="number"
						min={0}
						value={idleTimeout}
						placeholder="不自动关闭"
						onChange={(event) => setIdleTimeout(event.target.value)}
					/>
				</label>
				<label className="more-app-field">
					<span>启动命令（只读）</span>
					<textarea readOnly value={app.commandLine} rows={2} />
				</label>
				{app.status === "error" && app.error ? <div className="more-app-error">⚠ {app.error}</div> : null}
				<div className="more-app-modal-actions">
					<button type="button" className="more-app-btn ghost" onClick={onClose}>
						取消
					</button>
					<button type="button" className="more-app-btn primary" onClick={save}>
						保存
					</button>
				</div>
			</div>
		</div>
	);
}

function AppTerminalPanel({
	app,
	lines,
	onClose,
}: {
	app: MoreAppView;
	lines: MoreAppTerminalLine[];
	onClose: () => void;
}) {
	const bodyRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const el = bodyRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [lines]);

	return (
		<div className="more-app-terminal">
			<div className="more-app-terminal-head">
				<span>
					{app.icon} {app.name} · 终端{app.port ? ` · :${app.port}` : ""}
				</span>
				<button type="button" className="title-btn" onClick={onClose} aria-label="关闭">
					<X size={16} />
				</button>
			</div>
			<div className="more-app-terminal-body" ref={bodyRef}>
				{lines.length === 0 ? (
					<div className="more-app-terminal-empty">暂无输出</div>
				) : (
					lines.map((line) => (
						<div key={line.seq} className={`more-app-terminal-line ${line.stream}`}>
							{line.text}
						</div>
					))
				)}
			</div>
		</div>
	);
}
