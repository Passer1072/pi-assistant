import {
	ArrowLeft,
	ChevronRight,
	Home,
	ListTodo,
	Loader2,
	Settings as SettingsIcon,
	Trash2,
	X,
} from "lucide-react";
import type { MemoSummary, SessionRunStatus, SessionSummary } from "../../../src/shared/types.ts";
import type { Route, StoredConversation } from "../app-types.ts";
import { formatTime } from "../formatters.ts";

const STATUS_LABEL: Record<SessionRunStatus, string> = {
	idle: "空闲",
	running: "运行中",
	queued: "等待桌面",
	awaiting_confirmation: "等待批准",
	error: "出错",
};

type DrawerConversationItem =
	| {
			kind: "live";
			id: string;
			updatedAt: number;
			session: SessionSummary;
	  }
	| {
			kind: "archive";
			id: string;
			updatedAt: number;
			conversation: StoredConversation;
	  };

function SessionStatusIndicator({ session }: { session: SessionSummary }) {
	if (session.pendingConfirmationCount > 0) {
		return <span className="session-dot dot-awaiting" title="等待批准" aria-label="等待批准" />;
	}
	if (session.unreadCompletion) {
		return <span className="session-dot dot-completed" title="已完成（未读）" aria-label="已完成（未读）" />;
	}
	if (session.status === "running") {
		return <Loader2 size={12} className="spin session-status-spin" aria-label="运行中" />;
	}
	if (session.status === "queued") {
		return (
			<span className="session-badge badge-queued" title="等待桌面空闲">
				排队
			</span>
		);
	}
	if (session.status === "error") {
		return <span className="session-dot dot-error" title="出错" aria-label="出错" />;
	}
	return null;
}

export function Drawer({
	open,
	onClose,
	docked = false,
	sessions,
	focusedSessionId,
	conversations,
	activeRoute,
	memoSummary,
	onOpenHome,
	onOpenMemo,
	onOpenSettings,
	activeId,
	loadingId,
	onSelect,
	onSelectSession,
	onCloseSession,
	onDelete,
}: {
	open: boolean;
	onClose: () => void;
	docked?: boolean;
	sessions: SessionSummary[];
	focusedSessionId?: string;
	conversations: StoredConversation[];
	activeRoute?: Route;
	memoSummary?: MemoSummary;
	onOpenHome: () => void;
	onOpenMemo: () => void;
	onOpenSettings: () => void;
	activeId: string | null;
	loadingId?: string;
	onSelect: (id: string) => void;
	onSelectSession: (id: string) => void;
	onCloseSession: (id: string) => void;
	onDelete: (id: string) => void;
}) {
	const memoBadge = (memoSummary?.overdueCount ?? 0) + (memoSummary?.dueTodayCount ?? 0);
	const liveSessionIds = new Set(sessions.map((session) => session.sessionId));
	const archivedConversations = conversations.filter((conversation) => !liveSessionIds.has(conversation.sessionId));
	const conversationItems: DrawerConversationItem[] = [
		...sessions.map((session) => ({
			kind: "live" as const,
			id: session.sessionId,
			updatedAt: session.lastActivityAt,
			session,
		})),
		...archivedConversations.map((conversation) => ({
			kind: "archive" as const,
			id: conversation.sessionId,
			updatedAt: conversation.updatedAt,
			conversation,
		})),
	].sort((left, right) => right.updatedAt - left.updatedAt);

	return (
		<>
			{docked ? null : <div className={`drawer-scrim ${open ? "show" : ""}`} onClick={onClose} />}
			<aside className={`drawer ${docked ? "docked" : ""} ${open ? "open" : ""}`} aria-hidden={!open}>
				{docked ? null : (
					<div className="drawer-head">
						<button className="title-btn" onClick={onClose} type="button" aria-label="收起">
							<ArrowLeft size={16} />
						</button>
						<div className="title-label">会话</div>
					</div>
				)}

				<button
					className={`drawer-nav ${activeRoute === "home" ? "active" : ""}`}
					type="button"
					onClick={onOpenHome}
				>
					<Home size={15} />
					<span>首页</span>
				</button>

				<button
					className={`drawer-nav ${activeRoute === "memo" ? "active" : ""}`}
					type="button"
					onClick={onOpenMemo}
				>
					<ListTodo size={15} />
					<span>备忘录</span>
					{memoBadge > 0 ? <span className="drawer-badge">{memoBadge}</span> : null}
				</button>

				<div className="drawer-section-label">会话列表</div>
				<div className="drawer-list">
					{conversationItems.length > 0 ? (
						conversationItems.map((item) => {
							if (item.kind === "live") {
								const { session } = item;
								return (
									<div
										key={item.id}
										className={`drawer-item ${focusedSessionId === session.sessionId ? "active" : ""}`}
									>
										<button
											type="button"
											className="drawer-item-body"
											onClick={() => onSelectSession(session.sessionId)}
										>
											<div className="drawer-item-title">{session.title}</div>
											<div className="drawer-item-sub">
												<span className="drawer-item-preview">{STATUS_LABEL[session.status]}</span>
												<span className="drawer-item-indicator">
													<SessionStatusIndicator session={session} />
												</span>
											</div>
										</button>
										<button
											type="button"
											className="drawer-item-delete"
											aria-label={`关闭 ${session.title}`}
											title="关闭该运行会话（不删除存档）"
											onClick={(event) => {
												event.stopPropagation();
												onCloseSession(session.sessionId);
											}}
										>
											<X size={13} />
										</button>
									</div>
								);
							}

							const { conversation } = item;
							const loading = loadingId === conversation.sessionId;
							return (
								<div key={item.id} className={`drawer-item ${activeId === conversation.sessionId ? "active" : ""}`}>
									<button
										type="button"
										className="drawer-item-body"
										disabled={loading}
										onClick={() => onSelect(conversation.sessionId)}
									>
										<div className="drawer-item-title">{conversation.title}</div>
										<div className="drawer-item-sub">
											<span className="drawer-item-preview">{conversation.preview}</span>
											<span className="drawer-item-time">
												{loading ? <Loader2 size={11} className="spin" /> : formatTime(conversation.updatedAt)}
											</span>
										</div>
									</button>
									<button
										type="button"
										className="drawer-item-delete"
										aria-label={`删除 ${conversation.title}`}
										title="删除该对话"
										onClick={(event) => {
											event.stopPropagation();
											onDelete(conversation.sessionId);
										}}
									>
										<Trash2 size={13} />
									</button>
								</div>
							);
						})
					) : (
						<div className="drawer-empty">还没有会话</div>
					)}
				</div>

				<div className="drawer-footer">
					<button className="drawer-foot-btn" type="button" onClick={onOpenSettings}>
						<SettingsIcon size={15} />
						<span>设置</span>
						<ChevronRight size={14} />
					</button>
				</div>
			</aside>
		</>
	);
}
