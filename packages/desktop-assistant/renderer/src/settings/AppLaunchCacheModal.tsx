import { Eye, Loader2, Trash2, X } from "lucide-react";
import type { AppLaunchCacheView } from "../../../src/shared/types.ts";

export function AppLaunchCacheModal({
	cache,
	busy,
	status,
	onClose,
	onRefresh,
	onClear,
}: {
	cache: AppLaunchCacheView;
	busy: boolean;
	status: string;
	onClose: () => void;
	onRefresh: () => void;
	onClear: () => void;
}) {
	const entries = Object.entries(cache.aliases).sort(([a], [b]) => a.localeCompare(b));
	return (
		<div className="cache-modal-backdrop" role="presentation">
			<section className="cache-modal" role="dialog" aria-modal="true" aria-label="应用启动记忆">
				<header className="cache-modal-head">
					<div>
						<span className="cache-kicker">App Launch Memory</span>
						<h2>应用启动记忆</h2>
						<p>这里记录 AI 已经学会的应用别名和启动路径，新对话会继续使用。</p>
					</div>
					<button className="title-btn danger" type="button" onClick={onClose} aria-label="关闭">
						<X size={15} />
					</button>
				</header>
				<div className="cache-summary-grid">
					<div>
						<span>别名数量</span>
						<strong>{entries.length}</strong>
					</div>
					<div>
						<span>更新时间</span>
						<strong>{cache.updatedAt ? new Date(cache.updatedAt).toLocaleString("zh-CN") : "暂无"}</strong>
					</div>
				</div>
				<div className="cache-path-card">
					<span>缓存文件</span>
					<code>{cache.path}</code>
				</div>
				<div className="cache-modal-actions">
					<button className="ghost-btn wide" type="button" onClick={onRefresh} disabled={busy}>
						{busy ? <Loader2 size={14} className="spin" /> : <Eye size={14} />}
						<span>刷新</span>
					</button>
					<button className="danger-btn" type="button" onClick={onClear} disabled={busy || entries.length === 0}>
						<Trash2 size={13} />
						<span>清空记忆</span>
					</button>
				</div>
				{status ? <div className="cache-status">{status}</div> : null}
				<div className="cache-entry-list">
					{entries.length === 0 ? (
						<div className="cache-empty">暂无应用启动记忆。成功打开应用后，这里会自动出现记录。</div>
					) : (
						entries.map(([alias, entry]) => (
							<article className="cache-entry" key={alias}>
								<div className="cache-entry-top">
									<div>
										<strong>{alias}</strong>
										<span>{entry.displayName}</span>
									</div>
									<small>{entry.kind}</small>
								</div>
								<code>{entry.launch}</code>
								<div className="cache-entry-meta">
									<span>成功 {entry.successCount}</span>
									<span>失败 {entry.failCount}</span>
									{entry.sourceQueries.length > 0 ? <span>来源 {entry.sourceQueries.join(" / ")}</span> : null}
								</div>
							</article>
						))
					)}
				</div>
			</section>
		</div>
	);
}
