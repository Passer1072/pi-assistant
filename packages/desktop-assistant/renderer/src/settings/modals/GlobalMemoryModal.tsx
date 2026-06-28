import { Brain, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import type { GlobalMemoryEntry } from "../../../../src/shared/types.ts";

export function GlobalMemoryModal({
	memories,
	busy,
	status,
	onClose,
	onRefresh,
	onClear,
	onDelete,
}: {
	memories: GlobalMemoryEntry[];
	busy: boolean;
	status: string;
	onClose: () => void;
	onRefresh: () => void;
	onClear: () => void;
	onDelete: (id: string) => void;
}) {
	return (
		<div className="cache-modal-backdrop" role="presentation" onClick={onClose}>
			<section className="cache-modal" role="dialog" aria-modal="true" aria-label="跨对话记忆" onClick={(event) => event.stopPropagation()}>
				<header className="cache-modal-head">
					<div>
						<span className="cache-kicker">Cross-Conversation Memory</span>
						<h2>跨对话记忆</h2>
						<p>这里是 AI 在对话间记住的事实，新请求会按相关性检索注入。</p>
					</div>
					<button className="title-btn danger" type="button" onClick={onClose} aria-label="关闭">
						<X size={15} />
					</button>
				</header>
				<div className="cache-summary-grid">
					<div>
						<span>记忆数量</span>
						<strong>{memories.length}</strong>
					</div>
				</div>
				<div className="cache-modal-actions">
					<button className="ghost-btn wide" type="button" onClick={onRefresh} disabled={busy}>
						{busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
						<span>刷新</span>
					</button>
					<button className="danger-btn" type="button" onClick={onClear} disabled={busy || memories.length === 0}>
						<Trash2 size={13} />
						<span>清空全部</span>
					</button>
				</div>
				{status ? <div className="cache-status">{status}</div> : null}
				<div className="cache-entry-list">
					{memories.length === 0 ? (
						<div className="cache-empty">暂无跨对话记忆。开启自动提取后，对话中确认的事实会出现在这里。</div>
					) : (
						memories.map((memory) => (
							<article className="cache-entry memory-entry" key={memory.id}>
								<div className="cache-entry-top">
									<div className="memory-entry-title">
										<Brain size={14} />
										<strong>{memory.kind}</strong>
									</div>
									<button type="button" className="ghost-btn icon-only" onClick={() => onDelete(memory.id)} disabled={busy} aria-label="删除记忆">
										<X size={13} />
									</button>
								</div>
								<p className="memory-entry-text">{memory.text}</p>
								<div className="cache-entry-meta">
									<span>{memory.scope}</span>
									<span>{memory.source}</span>
									<span>置信 {memory.confidence.toFixed(2)}</span>
								</div>
							</article>
						))
					)}
				</div>
			</section>
		</div>
	);
}
