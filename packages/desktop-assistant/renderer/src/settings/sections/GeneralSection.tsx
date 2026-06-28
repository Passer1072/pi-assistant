import { Eye, Pin, PinOff, Trash2 } from "lucide-react";
import type { SettingsSectionCtx } from "../section-ctx.ts";
import { Toggle } from "../section-kit.tsx";

export function GeneralSection({ ctx }: { ctx: SettingsSectionCtx }) {
	return (
		<>
			<section className="set-section">
				<h3>窗口</h3>
				<label className="set-row toggle-row">
					<span className="setting-label-with-icon">
						{ctx.windowAlwaysOnTop ? <Pin size={14} /> : <PinOff size={14} />}
						<span>窗口置顶</span>
					</span>
					<Toggle on={ctx.windowAlwaysOnTop} onToggle={() => ctx.onWindowAlwaysOnTopChange(!ctx.windowAlwaysOnTop)} label="窗口置顶" />
				</label>
			</section>

			<section className="set-section">
				<h3>历史对话</h3>
				<div className="history-controls">
					<div className="history-info">
						<span>本机已保存</span>
						<strong>{ctx.historyCount}</strong>
						<small>条对话记录</small>
					</div>
					<button
						type="button"
						className="danger-btn"
						disabled={ctx.historyCount === 0}
						onClick={() => {
							if (ctx.historyCount === 0) return;
							if (window.confirm(`确定要清空全部 ${ctx.historyCount} 条历史对话吗？此操作无法撤销。`)) {
								ctx.onClearHistory();
							}
						}}
					>
						<Trash2 size={13} />
						<span>清空全部</span>
					</button>
				</div>
				<p className="set-hint">历史对话仅保存在本机浏览器存储中，清空后无法恢复。</p>
			</section>

			<section className="set-section">
				<h3>开发者工具</h3>
				<div className="history-controls">
					<div className="history-info">
						<span>后端服务响应日志</span>
					</div>
					<button type="button" className="ghost-btn wide" onClick={() => window.desktopAssistant?.openLogWindow?.()}>
						<Eye size={14} />
						<span>打开日志窗口</span>
					</button>
				</div>
				<p className="set-hint">实时显示所有后端事件：用户输入、工具调用、AI 响应、重试、错误等。</p>
			</section>

			<section className="set-section">
				<h3>关于</h3>
				<div className="about-row">
					<span>Pi 桌面助手</span>
					<small>v0.1.0 · Windows 系统操作能力</small>
				</div>
			</section>
		</>
	);
}
