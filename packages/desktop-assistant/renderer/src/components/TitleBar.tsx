import { Globe, Maximize2, Menu, Mic, Minimize2, Minus, X } from "lucide-react";
import type React from "react";
import type {
	DesktopAssistantSettings,
	DesktopAssistantSnapshot,
	WakeWordModelMetadata,
	WindowMode,
} from "../../../src/shared/types.ts";
import { buildMicStatusTitle, voiceToneLabels, voiceToneOf } from "../voice-ui.ts";

const WEB_SEARCH_LABEL: Record<string, string> = {
	auto: "联网自动",
	on: "联网开启",
	off: "联网关闭",
};

export function TitleBar({
	onMenu,
	title,
	webSearchMode,
	voiceOverlay,
	voiceSettings,
	wakeModels,
	windowMode,
	onToggleWindowMode,
}: {
	onMenu: () => void;
	title: string;
	webSearchMode?: string;
	voiceOverlay?: DesktopAssistantSnapshot["voiceOverlay"];
	voiceSettings?: DesktopAssistantSettings["voice"];
	wakeModels?: WakeWordModelMetadata[];
	windowMode?: WindowMode;
	onToggleWindowMode?: () => void;
}) {
	const minimize = () => {
		window.desktopAssistant?.minimizeWindow?.();
	};
	const close = () => {
		window.desktopAssistant?.closeWindow?.();
	};
	return (
		<div className="titlebar" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
			<button
				className="title-btn"
				onClick={onMenu}
				type="button"
				aria-label="菜单"
				style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
			>
				<Menu size={16} />
			</button>
			<div className="title-label">{title}</div>
			{voiceOverlay ? (
				<div
					className={`mic-status-badge ${voiceToneOf(voiceOverlay.state)}`}
					title={buildMicStatusTitle(voiceOverlay, voiceSettings, wakeModels)}
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					<Mic size={11} />
					<span>{voiceToneLabels[voiceToneOf(voiceOverlay.state)]}</span>
				</div>
			) : null}
			{webSearchMode && webSearchMode !== "off" && (
				<div
					className={`web-search-badge ${webSearchMode}`}
					title={WEB_SEARCH_LABEL[webSearchMode] ?? "联网"}
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					<Globe size={11} />
					<span>{WEB_SEARCH_LABEL[webSearchMode] ?? "联网"}</span>
				</div>
			)}
			{onToggleWindowMode ? (
				<button
					className="title-btn window-mode-toggle"
					onClick={onToggleWindowMode}
					type="button"
					aria-label={windowMode === "expanded" ? "切换到紧凑模式" : "切换到大窗口模式"}
					title={windowMode === "expanded" ? "紧凑聊天框" : "大窗口模式"}
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					{windowMode === "expanded" ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
				</button>
			) : null}
			<div className="title-window-controls" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
				<button className="title-btn" onClick={minimize} type="button" aria-label="最小化">
					<Minus size={14} />
				</button>
				<button className="title-btn danger" onClick={close} type="button" aria-label="关闭">
					<X size={14} />
				</button>
			</div>
		</div>
	);
}
