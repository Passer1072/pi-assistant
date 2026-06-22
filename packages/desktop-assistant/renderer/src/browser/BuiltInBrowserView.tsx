import type React from "react";
import {
	ArrowLeft,
	ArrowRight,
	Bot,
	Globe,
	Loader2,
	Lock,
	Minus,
	MousePointer2,
	Pause,
	Plus,
	RefreshCw,
	RotateCcw,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserSettings, BrowserShortcut, BrowserTabView, BuiltInBrowserStatus } from "../../../src/shared/types.ts";
import { BrowserHomePage } from "./BrowserHomePage.tsx";
import { resolveOmniboxUrl } from "./home-page-url.ts";

const DEFAULT_SEARCH_TEMPLATE = "https://www.google.com/search?q=%s";

export function BuiltInBrowserView() {
	const [status, setStatus] = useState<BuiltInBrowserStatus | undefined>();
	const [browserSettings, setBrowserSettings] = useState<BrowserSettings | undefined>();
	const [address, setAddress] = useState("");
	const [addressFocused, setAddressFocused] = useState(false);
	const [busy, setBusy] = useState(false);
	const contentRef = useRef<HTMLDivElement | null>(null);

	const activeTab = useMemo(() => status?.tabs.find((tab) => tab.active), [status?.tabs]);
	const searchTemplate = browserSettings?.searchTemplate || DEFAULT_SEARCH_TEMPLATE;

	const run = useCallback(async (action: () => Promise<BuiltInBrowserStatus | void>) => {
		setBusy(true);
		try {
			const next = await action();
			if (next) setStatus(next);
		} finally {
			setBusy(false);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		void window.desktopAssistant
			.openBuiltInBrowser()
			.then((next) => {
				if (!cancelled) setStatus(next);
			})
			.catch((error) => console.warn("Failed to open built-in browser:", error));
		void window.desktopAssistant
			.getSnapshot()
			.then((snapshot) => {
				if (!cancelled) setBrowserSettings(snapshot.settings.browser);
			})
			.catch((error) => console.warn("Failed to load browser settings:", error));
		const unsubscribeStatus = window.desktopAssistant.onBuiltInBrowserEvent((event) => {
			if (event.type === "status") setStatus(event.status);
		});
		const unsubscribeSettings = window.desktopAssistant.onEvent((event) => {
			if (event.type === "snapshot" && event.snapshot) setBrowserSettings(event.snapshot.settings.browser);
		});
		return () => {
			cancelled = true;
			unsubscribeStatus();
			unsubscribeSettings();
		};
	}, []);

	useEffect(() => {
		if (!activeTab || addressFocused) return;
		setAddress(activeTab.url);
	}, [activeTab, addressFocused]);

	useEffect(() => {
		const node = contentRef.current;
		if (!node) return undefined;
		let raf = 0;
		const reportBounds = () => {
			window.cancelAnimationFrame(raf);
			raf = window.requestAnimationFrame(() => {
				const rect = node.getBoundingClientRect();
				void window.desktopAssistant.builtInBrowserSetContentBounds({
					x: Math.round(rect.left),
					y: Math.round(rect.top),
					width: Math.round(rect.width),
					height: Math.round(rect.height),
				});
			});
		};
		reportBounds();
		const observer = new ResizeObserver(reportBounds);
		observer.observe(node);
		window.addEventListener("resize", reportBounds);
		return () => {
			window.cancelAnimationFrame(raf);
			observer.disconnect();
			window.removeEventListener("resize", reportBounds);
		};
	}, []);

	const navigateTo = useCallback(
		(rawUrl: string) => {
			const url = rawUrl.trim();
			if (!url) return;
			void run(() => window.desktopAssistant.builtInBrowserNavigate({ tabId: activeTab?.id, url }));
		},
		[activeTab?.id, run],
	);

	const submitAddress = (event: React.FormEvent) => {
		event.preventDefault();
		navigateTo(resolveOmniboxUrl(address, searchTemplate));
	};

	const persistShortcuts = useCallback(
		(shortcuts: BrowserShortcut[]) => {
			if (!browserSettings) return;
			const nextBrowser = { ...browserSettings, shortcuts };
			setBrowserSettings(nextBrowser); // optimistic; the snapshot event will confirm
			void window.desktopAssistant
				.updateSettings({ settings: { browser: nextBrowser } })
				.catch((error) => console.warn("Failed to save shortcuts:", error));
		},
		[browserSettings],
	);

	return (
		<div className="browser-screen">
			<div className="glass-bg" aria-hidden />
			<header className="browser-titlebar">
				<div className="browser-title">
					<Globe size={16} />
					<span>内置浏览器</span>
				</div>
				<div className="browser-control-chip active">
					<Bot size={13} />
					<span>AI 控制中</span>
				</div>
				<div className="title-window-controls" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
					<button
						className="title-btn"
						type="button"
						title="最小化"
						aria-label="最小化"
						onClick={() => window.desktopAssistant.minimizeWindow()}
					>
						<Minus size={14} />
					</button>
					<button
						className="title-btn danger"
						type="button"
						title="关闭"
						aria-label="关闭"
						onClick={() => window.desktopAssistant.closeWindow()}
					>
						<X size={14} />
					</button>
				</div>
			</header>

			<div className="browser-tabs" role="tablist" aria-label="浏览器标签页">
				{status?.tabs.map((tab) => (
					<TabButton
						key={tab.id}
						tab={tab}
						onSwitch={() => void run(() => window.desktopAssistant.builtInBrowserSwitchTab({ tabId: tab.id }))}
						onClose={() => void run(() => window.desktopAssistant.builtInBrowserCloseTab({ tabId: tab.id }))}
					/>
				))}
				<button
					type="button"
					className="browser-tab-add"
					title="新标签页"
					aria-label="新标签页"
					disabled={busy || (status ? status.tabs.length >= status.maxTabs : false)}
					onClick={() => void run(() => window.desktopAssistant.builtInBrowserNewTab())}
				>
					<Plus size={15} />
				</button>
			</div>

			<div className="browser-toolbar">
				<button
					type="button"
					className="title-btn"
					title="后退"
					aria-label="后退"
					disabled={!activeTab?.canGoBack || busy}
					onClick={() => void run(() => window.desktopAssistant.builtInBrowserGoBack({ tabId: activeTab?.id }))}
				>
					<ArrowLeft size={15} />
				</button>
				<button
					type="button"
					className="title-btn"
					title="前进"
					aria-label="前进"
					disabled={!activeTab?.canGoForward || busy}
					onClick={() => void run(() => window.desktopAssistant.builtInBrowserGoForward({ tabId: activeTab?.id }))}
				>
					<ArrowRight size={15} />
				</button>
				<button
					type="button"
					className="title-btn"
					title={activeTab?.loading ? "停止" : "刷新"}
					aria-label={activeTab?.loading ? "停止" : "刷新"}
					disabled={busy}
					onClick={() =>
						void run(() =>
							activeTab?.loading
								? window.desktopAssistant.builtInBrowserStop({ tabId: activeTab.id })
								: window.desktopAssistant.builtInBrowserReload({ tabId: activeTab?.id }),
						)
					}
				>
					{activeTab?.loading ? <X size={15} /> : <RefreshCw size={15} />}
				</button>
				<form className="browser-address" onSubmit={submitAddress}>
					<Lock size={13} />
					<input
						value={address}
						onFocus={() => setAddressFocused(true)}
						onBlur={() => setAddressFocused(false)}
						onChange={(event) => setAddress(event.target.value)}
						placeholder="输入网址或搜索"
						spellCheck={false}
					/>
					<button type="submit" title="打开" aria-label="打开" disabled={busy || !address.trim()}>
						{busy ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}
					</button>
				</form>
				<div className="browser-control-chip">
					<MousePointer2 size={13} />
					<span>虚拟鼠标</span>
				</div>
				<button type="button" className="browser-control-chip button" title="暂停控制" aria-label="暂停控制">
					<Pause size={13} />
					<span>暂停控制</span>
				</button>
			</div>

			<div ref={contentRef} className="browser-content-host">
				{!status ? <div className="browser-loading">正在启动内置浏览器...</div> : null}
				{status && activeTab?.homePage ? (
					<BrowserHomePage
						shortcuts={browserSettings?.shortcuts ?? []}
						recent={status.recent}
						searchTemplate={searchTemplate}
						onNavigate={navigateTo}
						onShortcutsChange={persistShortcuts}
					/>
				) : null}
			</div>
		</div>
	);
}

function TabButton({
	tab,
	onSwitch,
	onClose,
}: {
	tab: BrowserTabView;
	onSwitch: () => void;
	onClose: () => void;
}) {
	return (
		<div className={`browser-tab ${tab.active ? "active" : ""}`} role="tab" aria-selected={tab.active}>
			<button type="button" className="browser-tab-main" onClick={onSwitch} title={tab.title || tab.url}>
				{tab.loading ? <Loader2 size={13} className="spin" /> : <Globe size={13} />}
				<span>{tab.title || tab.url || "新标签页"}</span>
			</button>
			<button type="button" className="browser-tab-close" onClick={onClose} title="关闭标签页" aria-label="关闭标签页">
				<X size={12} />
			</button>
		</div>
	);
}
