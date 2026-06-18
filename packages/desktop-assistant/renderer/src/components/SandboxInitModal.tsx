import { Loader2, RefreshCw, Settings, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SandboxStatus } from "../../../src/shared/types.ts";

const PHASE_LABEL: Record<SandboxStatus["phase"], string> = {
	uninitialized: "未初始化",
	initializing: "正在初始化",
	ready: "沙箱就绪",
	failed: "初始化失败",
	stuck: "初始化卡住",
};

/**
 * Home-page floating progress chip for sandbox initialization. Chat stays usable
 * behind it; on failure/stuck it offers retry / open-settings escape hatches.
 */
export function SandboxInitModal({
	status,
	busy,
	onRetry,
	onClose,
	onOpenSettings,
}: {
	status: SandboxStatus;
	busy: boolean;
	onRetry: () => void;
	onClose: () => void;
	onOpenSettings: () => void;
}) {
	const failed = status.phase === "failed" || status.phase === "stuck";
	const ready = status.phase === "ready";
	const progress = ready ? 100 : Math.max(0, Math.min(100, status.progress));
	const usageLabel = `${status.usageMb}MB / ${status.quotaMb}MB`;
	const onCloseRef = useRef(onClose);
	const [closing, setClosing] = useState(false);

	onCloseRef.current = onClose;

	useEffect(() => {
		if (!ready) {
			setClosing(false);
			return undefined;
		}

		const fadeTimer = window.setTimeout(() => setClosing(true), 1000);
		const closeTimer = window.setTimeout(() => onCloseRef.current(), 1180);
		return () => {
			window.clearTimeout(fadeTimer);
			window.clearTimeout(closeTimer);
		};
	}, [ready]);

	return (
		<div className="sandbox-init-float" role="presentation">
			<section
				className={`sandbox-init-card ${closing ? "closing" : ""}`}
				role="region"
				aria-live="polite"
				aria-label="沙箱初始化进度"
			>
				<header className="sandbox-init-head">
					<div className="sandbox-init-title">
						<span className="cache-kicker">Sandbox</span>
						<div>
							<h2>{PHASE_LABEL[status.phase]}</h2>
							<p>{ready ? "沙箱工作区已就绪" : status.currentStep}</p>
						</div>
					</div>
					<button className="title-btn danger" type="button" onClick={onClose} aria-label="关闭">
						<X size={15} />
					</button>
				</header>

				<div className="sandbox-progress-track" aria-hidden>
					<span className={`sandbox-progress-fill ${failed ? "error" : ""}`} style={{ width: `${progress}%` }} />
				</div>

				<div className="sandbox-init-meta">
					<span>进度 {progress}%</span>
					<span>{usageLabel}</span>
				</div>

				{failed && status.rootDir ? (
					<div className="cache-path-card">
						<span>沙箱目录</span>
						<code>{status.rootDir}</code>
					</div>
				) : null}

				{failed && status.lastError ? <div className="cache-status">{status.lastError}</div> : null}

				{failed ? (
					<div className="cache-modal-actions">
						<button className="ghost-btn wide" type="button" onClick={onRetry} disabled={busy}>
							{busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
							<span>重试初始化</span>
						</button>
						<button className="ghost-btn" type="button" onClick={onOpenSettings}>
							<Settings size={14} />
							<span>打开沙箱设置</span>
						</button>
					</div>
				) : null}

				{failed ? (
					<div className="cache-empty">
						沙箱暂不可用。你可以重试、重启应用，或在权限模式允许时让 AI 直接在真实环境运行（仅沙盒模式除外）。
					</div>
				) : null}
			</section>
		</div>
	);
}
