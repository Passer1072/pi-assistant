import {
	ChevronDown,
	ExternalLink,
	Folder,
	GripVertical,
	Lock,
	LockOpen,
	PanelRightClose,
	PanelRightOpen,
	SquareTerminal,
	Workflow,
	Globe,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
	DynamicWindowCommand,
	DynamicWindowFacet,
	DynamicWindowFacetState,
	DynamicWindowFileNode,
	DynamicWindowOperation,
	DynamicWindowSnapshot,
	DynamicWindowWebPage,
	FileArtifact,
	LiveFlowSnapshot,
} from "../../../src/shared/types.ts";
import { deriveFlowEdgeProgress, FlowGraphPreview } from "../automation/FlowGraph.tsx";
import { FileArtifactList } from "./FileArtifactCard.tsx";
import { buildFileTree } from "./dynamic-window-tree.ts";

const POS_KEY = "dynamicWindow.pos";
const COLLAPSED_KEY = "dynamicWindow.collapsed";
const LOCKED_KEY = "dynamicWindow.locked";

const FACET_ORDER: DynamicWindowFacet[] = ["flow", "files", "web", "commands"];
const FACET_META: Record<DynamicWindowFacet, { label: string; icon: typeof Folder }> = {
	flow: { label: "流程", icon: Workflow },
	files: { label: "文件", icon: Folder },
	web: { label: "网页", icon: Globe },
	commands: { label: "命令", icon: SquareTerminal },
};

type Position = { left: number; top: number };

function readBool(key: string): boolean {
	try {
		return localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
}
function writeBool(key: string, value: boolean): void {
	try {
		localStorage.setItem(key, value ? "1" : "0");
	} catch {
		// localStorage may be unavailable; preference just won't persist.
	}
}
function loadPosition(): Position | null {
	try {
		const raw = localStorage.getItem(POS_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Position;
		return typeof parsed?.left === "number" && typeof parsed?.top === "number" ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * 灵动窗 — a per-conversation, multi-facet floating window that visualizes what the
 * model is doing (flow / files / web / commands) and lets the user interact with it.
 * Generalizes the old FloatingFlowWindow: the live flow is now just the "flow" facet.
 * Compact draggable by default; "展开/停靠" turns it into a stable right-side panel.
 * Reads `liveFlow` (flow facet) and `dynamicWindow` (the rest) straight off the snapshot.
 */
export function DynamicWindow({
	liveFlow,
	dynamicWindow,
	docked,
	onToggleDocked,
}: {
	liveFlow?: LiveFlowSnapshot;
	dynamicWindow?: DynamicWindowSnapshot;
	docked: boolean;
	onToggleDocked: () => void;
}) {
	const winRef = useRef<HTMLDivElement>(null);
	const dragOffset = useRef<{ dx: number; dy: number } | null>(null);
	const [pos, setPos] = useState<Position | null>(() => loadPosition());
	const [collapsed, setCollapsed] = useState<boolean>(() => readBool(COLLAPSED_KEY));
	const [locked, setLocked] = useState<boolean>(() => readBool(LOCKED_KEY));

	const sig: Record<DynamicWindowFacet, number> = useMemo(
		() => ({
			flow: liveFlow?.updatedAt ?? 0,
			files: dynamicWindow ? dynamicWindow.files.items.length + dynamicWindow.files.produced.length : 0,
			web: dynamicWindow?.web.items.length ?? 0,
			commands: dynamicWindow?.commands.items.length ?? 0,
		}),
		[liveFlow?.updatedAt, dynamicWindow],
	);

	const available = useMemo(() => FACET_ORDER.filter((facet) => sig[facet] > 0), [sig]);
	const [displayFacet, setDisplayFacet] = useState<DynamicWindowFacet>(available[0] ?? "flow");
	const [seen, setSeen] = useState<Record<string, number>>(() => ({ ...sig }));

	// Keep the displayed facet valid as facets appear/disappear.
	useEffect(() => {
		if (available.length === 0) return;
		if (!available.includes(displayFacet)) setDisplayFacet(available[0]);
	}, [available, displayFacet]);

	// Auto-follow the backend's suggested facet, unless the user has locked the view.
	useEffect(() => {
		if (locked) return;
		const target = dynamicWindow?.activeFacet;
		if (target && available.includes(target)) setDisplayFacet(target);
	}, [dynamicWindow?.activeFacet, dynamicWindow?.updatedAt, locked, available]);

	// Mark the displayed facet as read (clears its red dot) once its content is in view.
	useEffect(() => {
		setSeen((prev) => (prev[displayFacet] === sig[displayFacet] ? prev : { ...prev, [displayFacet]: sig[displayFacet] }));
	}, [displayFacet, sig]);

	useEffect(() => writeBool(COLLAPSED_KEY, collapsed), [collapsed]);
	useEffect(() => writeBool(LOCKED_KEY, locked), [locked]);
	useEffect(() => {
		try {
			if (pos) localStorage.setItem(POS_KEY, JSON.stringify(pos));
		} catch {
			// best-effort persistence
		}
	}, [pos]);

	const onHeaderPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || docked) return;
		const element = winRef.current;
		const parent = element?.offsetParent as HTMLElement | null;
		if (!element || !parent) return;
		const elementRect = element.getBoundingClientRect();
		const parentRect = parent.getBoundingClientRect();
		dragOffset.current = { dx: event.clientX - elementRect.left, dy: event.clientY - elementRect.top };
		setPos({ left: elementRect.left - parentRect.left, top: elementRect.top - parentRect.top });
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const onHeaderPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		const offset = dragOffset.current;
		const element = winRef.current;
		const parent = element?.offsetParent as HTMLElement | null;
		if (!offset || !element || !parent || docked) return;
		const parentRect = parent.getBoundingClientRect();
		const maxLeft = Math.max(0, parent.clientWidth - element.offsetWidth);
		const maxTop = Math.max(0, parent.clientHeight - element.offsetHeight);
		const left = Math.min(Math.max(0, event.clientX - parentRect.left - offset.dx), maxLeft);
		const top = Math.min(Math.max(0, event.clientY - parentRect.top - offset.dy), maxTop);
		setPos({ left, top });
	};
	const onHeaderPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
		dragOffset.current = null;
		event.currentTarget.releasePointerCapture?.(event.pointerId);
	};

	if (available.length === 0) return null;

	const style = !docked && pos ? { left: `${pos.left}px`, top: `${pos.top}px`, right: "auto", bottom: "auto" } : undefined;
	const className = `dynamic-window${collapsed ? " collapsed" : ""}${docked ? " docked" : ""}`;

	return (
		<div ref={winRef} className={className} style={style}>
			<div
				className="dynamic-window-head"
				onPointerDown={onHeaderPointerDown}
				onPointerMove={onHeaderPointerMove}
				onPointerUp={onHeaderPointerUp}
			>
				{!docked ? <GripVertical size={13} className="dynamic-window-grip" /> : null}
				<span className="dynamic-window-title">灵动窗</span>
				<div className="dynamic-window-ctrls">
					<button
						type="button"
						className={`dynamic-window-ctrl${locked ? " on" : ""}`}
						aria-label={locked ? "解锁自动跟随" : "锁定当前面"}
						title={locked ? "已锁定：不随模型动作自动切换" : "自动跟随：随模型动作切换内容面"}
						onPointerDown={(event) => event.stopPropagation()}
						onClick={() => setLocked((value) => !value)}
					>
						{locked ? <Lock size={13} /> : <LockOpen size={13} />}
					</button>
					<button
						type="button"
						className="dynamic-window-ctrl"
						aria-label={docked ? "收起为浮窗" : "展开停靠为右侧面板"}
						title={docked ? "收起为浮窗" : "展开/停靠为右侧面板"}
						onPointerDown={(event) => event.stopPropagation()}
						onClick={onToggleDocked}
					>
						{docked ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
					</button>
					<button
						type="button"
						className="dynamic-window-collapse"
						aria-label={collapsed ? "展开" : "折叠"}
						aria-expanded={!collapsed}
						onPointerDown={(event) => event.stopPropagation()}
						onClick={() => setCollapsed((value) => !value)}
					>
						<ChevronDown size={14} />
					</button>
				</div>
			</div>

			{collapsed ? null : (
				<>
					<nav className="dynamic-window-tabs" role="tablist">
						{available.map((facet) => {
							const Meta = FACET_META[facet];
							const Icon = Meta.icon;
							const unread = facet !== displayFacet && sig[facet] !== (seen[facet] ?? 0);
							return (
								<button
									key={facet}
									type="button"
									role="tab"
									aria-selected={facet === displayFacet}
									className={`dynamic-window-tab${facet === displayFacet ? " active" : ""}`}
									onClick={() => {
										setDisplayFacet(facet);
										setLocked(true);
									}}
								>
									<Icon size={15} />
									<span>{Meta.label}</span>
									{unread ? <span className="dynamic-window-dot" /> : null}
								</button>
							);
						})}
					</nav>
					<div className="dynamic-window-body">
						{displayFacet === "flow" && liveFlow ? <FlowFacet data={liveFlow} /> : null}
						{displayFacet === "files" && dynamicWindow ? <FilesFacet files={dynamicWindow.files} /> : null}
						{displayFacet === "web" && dynamicWindow ? <WebFacet web={dynamicWindow.web} /> : null}
						{displayFacet === "commands" && dynamicWindow ? <CommandsFacet commands={dynamicWindow.commands} /> : null}
					</div>
				</>
			)}
		</div>
	);
}

function OperationFilter({
	operations,
	value,
	onChange,
}: {
	operations: DynamicWindowOperation[];
	value: string;
	onChange: (next: string) => void;
}) {
	if (operations.length <= 1) return null;
	const recent = operations.slice(-6).reverse();
	return (
		<div className="dynamic-window-ops">
			<span className="dynamic-window-ops-label">回看</span>
			<button
				type="button"
				className={`dynamic-window-op${value === "all" ? " active" : ""}`}
				onClick={() => onChange("all")}
			>
				全部
			</button>
			{recent.map((op) => (
				<button
					key={op.id}
					type="button"
					className={`dynamic-window-op${value === op.id ? " active" : ""}`}
					title={op.label}
					onClick={() => onChange(op.id)}
				>
					{op.label.length > 10 ? `${op.label.slice(0, 10)}…` : op.label}
				</button>
			))}
		</div>
	);
}

function FlowFacet({ data }: { data: LiveFlowSnapshot }) {
	const doneSet = useMemo(() => new Set(data.doneNodeIds), [data.doneNodeIds]);
	const freshSet = useMemo(() => new Set(data.freshNodeIds ?? []), [data.freshNodeIds]);
	const { traversedEdgeIds, activeEdgeId } = useMemo(
		() => deriveFlowEdgeProgress(data.edges, doneSet, data.activeNodeId),
		[data.edges, doneSet, data.activeNodeId],
	);
	return (
		<div className="dynamic-window-flow">
			{data.nodes.length ? (
				<FlowGraphPreview
					nodes={data.nodes}
					edges={data.edges}
					activeNodeId={data.activeNodeId}
					doneNodeIds={doneSet}
					traversedEdgeIds={traversedEdgeIds}
					activeEdgeId={activeEdgeId}
					freshNodeIds={freshSet}
				/>
			) : (
				<div className="dynamic-window-empty">正在规划流程…</div>
			)}
			{data.currentStep ? <div className="dynamic-window-foot">{data.currentStep}</div> : null}
		</div>
	);
}

function FilesFacet({ files }: { files: DynamicWindowFacetState<DynamicWindowFileNode> & { produced: FileArtifact[] } }) {
	const [sub, setSub] = useState<"tree" | "prod">("tree");
	const [op, setOp] = useState<string>("all");
	const filtered = useMemo(
		() => (op === "all" ? files.items : files.items.filter((item) => item.operationId === op)),
		[files.items, op],
	);
	const tree = useMemo(() => buildFileTree(filtered), [filtered]);

	return (
		<div className="dynamic-window-files">
			<div className="dynamic-window-subtabs">
				<button type="button" className={sub === "tree" ? "on" : ""} onClick={() => setSub("tree")}>
					涉及文件 ({files.items.length})
				</button>
				<button type="button" className={sub === "prod" ? "on" : ""} onClick={() => setSub("prod")}>
					产出文件 ({files.produced.length})
				</button>
			</div>
			{sub === "tree" ? (
				<>
					<OperationFilter operations={files.operations} value={op} onChange={setOp} />
					{tree.length ? (
						<div className="dynamic-window-tree">
							{tree.map((node) => (
								<FileTreeNode key={node.path} node={node} depth={0} />
							))}
						</div>
					) : (
						<div className="dynamic-window-empty">暂无文件</div>
					)}
				</>
			) : files.produced.length ? (
				<FileArtifactList artifacts={files.produced} />
			) : (
				<div className="dynamic-window-empty">本次对话还没有产出文件</div>
			)}
		</div>
	);
}

function FileTreeNode({ node, depth }: { node: DynamicWindowFileNode; depth: number }) {
	if (node.isDirectory) {
		return (
			<div className="dynamic-window-tree-folder">
				<div className="dynamic-window-tree-row" style={{ paddingLeft: depth * 14 + 4 }}>
					<Folder size={14} className="dynamic-window-tree-ico" />
					<span className="dynamic-window-tree-name">{node.name}</span>
				</div>
				{node.children?.map((child) => (
					<FileTreeNode key={child.path} node={child} depth={depth + 1} />
				))}
			</div>
		);
	}
	const open = () => {
		void window.desktopAssistant.openPath({ path: node.path });
	};
	return (
		<div
			className={`dynamic-window-tree-row file${node.produced ? " produced" : ""}`}
			style={{ paddingLeft: depth * 14 + 4 }}
			role="button"
			tabIndex={0}
			title={node.path}
			onClick={open}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					open();
				}
			}}
		>
			<span className="dynamic-window-tree-name">{node.name}</span>
			{node.produced ? <span className="dynamic-window-tree-prod">产出</span> : null}
		</div>
	);
}

function WebFacet({ web }: { web: DynamicWindowFacetState<DynamicWindowWebPage> }) {
	const [op, setOp] = useState<string>("all");
	const filtered = op === "all" ? web.items : web.items.filter((page) => page.operationId === op);
	return (
		<div className="dynamic-window-web">
			<OperationFilter operations={web.operations} value={op} onChange={setOp} />
			{filtered.length ? (
				<div className="dynamic-window-list">
					{filtered.map((page) => (
						<button
							key={page.url}
							type="button"
							className="dynamic-window-web-item"
							title={page.url}
							onClick={() => void window.desktopAssistant.openBuiltInBrowser({ url: page.url })}
						>
							<Globe size={15} className="dynamic-window-web-ico" />
							<span className="dynamic-window-web-text">
								<span className="dynamic-window-web-title">{page.title}</span>
								<span className="dynamic-window-web-url">{page.url}</span>
							</span>
							<ExternalLink size={14} className="dynamic-window-web-open" />
						</button>
					))}
				</div>
			) : (
				<div className="dynamic-window-empty">暂无浏览记录</div>
			)}
		</div>
	);
}

function CommandsFacet({ commands }: { commands: DynamicWindowFacetState<DynamicWindowCommand> }) {
	const [op, setOp] = useState<string>("all");
	const filtered = op === "all" ? commands.items : commands.items.filter((cmd) => cmd.operationId === op);
	return (
		<div className="dynamic-window-commands">
			<OperationFilter operations={commands.operations} value={op} onChange={setOp} />
			{filtered.length ? (
				<div className="dynamic-window-list">
					{filtered.map((cmd) => (
						<div key={cmd.id} className={`dynamic-window-cmd ${cmd.status}`}>
							<div className="dynamic-window-cmd-line">{cmd.command}</div>
							{cmd.stdout ? <pre className="dynamic-window-cmd-out">{cmd.stdout}</pre> : null}
							{cmd.stderr ? <pre className="dynamic-window-cmd-err">{cmd.stderr}</pre> : null}
						</div>
					))}
				</div>
			) : (
				<div className="dynamic-window-empty">暂无命令</div>
			)}
		</div>
	);
}
