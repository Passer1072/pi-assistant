export type StartupPhase = "shell" | "snapshot" | "ready" | "background";

const PHASE_TEXT: Record<StartupPhase, string> = {
	shell: "启动界面",
	snapshot: "加载会话",
	ready: "进入主页",
	background: "后台加载",
};

export function StartupSplash({ phase }: { phase: StartupPhase }) {
	return (
		<main className="startup-splash" aria-live="polite">
			<div className="startup-brand">
				<div className="startup-mark" aria-hidden>
					Pi
				</div>
				<div>
					<h1>Pi Desktop Assistant</h1>
					<p>{PHASE_TEXT[phase]}</p>
				</div>
			</div>
			<div className="startup-progress" aria-hidden>
				<span />
			</div>
		</main>
	);
}
