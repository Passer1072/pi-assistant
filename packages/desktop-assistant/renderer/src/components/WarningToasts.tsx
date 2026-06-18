import { BellRing, CircleCheck, TriangleAlert, X } from "lucide-react";
import type { AppWarning, AppWarningTone } from "../app-types.ts";

const TONE_META: Record<AppWarningTone, { title: string; icon: typeof TriangleAlert }> = {
	error: { title: "语音识别失败", icon: TriangleAlert },
	awaiting: { title: "需要批准操作", icon: BellRing },
	completed: { title: "任务已完成", icon: CircleCheck },
};

export function WarningToasts({
	warnings,
	onDismiss,
	onSelect,
}: {
	warnings: AppWarning[];
	onDismiss: (id: string) => void;
	onSelect?: (sessionId: string) => void;
}) {
	if (!warnings.length) return null;
	return (
		<div className="warning-toast-stack" aria-live="polite" aria-atomic="false">
			{warnings.map((warning) => {
				const tone = warning.tone ?? "error";
				const meta = TONE_META[tone];
				const Icon = meta.icon;
				const clickable = Boolean(warning.sessionId && onSelect);
				return (
					<div
						className={`warning-toast tone-${tone} ${clickable ? "clickable" : ""}`}
						key={warning.id}
						role="status"
						onClick={clickable ? () => onSelect?.(warning.sessionId!) : undefined}
					>
						<div className="warning-toast-icon">
							<Icon size={16} />
						</div>
						<div className="warning-toast-copy">
							<strong>{warning.title ?? meta.title}</strong>
							<span>{warning.message}</span>
						</div>
						<button
							className="warning-toast-close"
							type="button"
							aria-label="关闭提示"
							onClick={(event) => {
								event.stopPropagation();
								onDismiss(warning.id);
							}}
						>
							<X size={14} />
						</button>
					</div>
				);
			})}
		</div>
	);
}
