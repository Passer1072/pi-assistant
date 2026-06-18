import type { AppLaunchCacheView } from "../shared/types.ts";

export function buildAppLaunchCacheHtml(cache: AppLaunchCacheView): string {
	const entries = Object.entries(cache.aliases).sort(([a], [b]) => a.localeCompare(b));
	const entryCards = entries
		.map(
			([alias, entry]) => `
				<article class="entry">
					<div class="entry-top">
						<div>
							<strong>${escapeHtml(alias)}</strong>
							<span>${escapeHtml(entry.displayName)}</span>
						</div>
						<div class="entry-actions">
							<small>${escapeHtml(entry.targetType)} / ${escapeHtml(entry.kind)}</small>
							<button class="btn danger compact" data-alias="${escapeHtml(alias)}" onclick="deleteEntry(this.dataset.alias)">删除</button>
						</div>
					</div>
					<code>${escapeHtml(entry.launch)}</code>
					<div class="entry-meta">
						<span>成功 ${entry.successCount}</span>
						<span>失败 ${entry.failCount}</span>
						${entry.sourceQueries.length > 0 ? `<span>来源 ${escapeHtml(entry.sourceQueries.join(" / "))}</span>` : ""}
					</div>
				</article>`,
		)
		.join("");

	return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>App Launch Memory</title>
</head>
<body>
	<div class="entries">${entryCards || '<div class="empty">暂无应用启动记忆。成功打开应用后，这里会自动出现记录。</div>'}</div>
	<script>
		async function deleteEntry(alias) {
			if (!alias) return;
			if (!confirm("删除这条启动记忆：" + alias + "？")) return;
			await window.desktopAssistant.deleteAppLaunchCacheEntry({ alias });
		}
	</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		const replacements: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		};
		return replacements[char] ?? char;
	});
}
