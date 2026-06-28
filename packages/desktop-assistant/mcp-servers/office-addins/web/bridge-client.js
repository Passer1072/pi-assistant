/* Runs inside an Office taskpane. It connects to the local bridge and executes
 * whitelisted Office.js operations in the visible document.
 */
let socket;
let reconnectDelay = 500;
let chatConfig = null;
let chatEvents = null;
let chatPollTimer = null;
let latestChatSnapshot = null;

Office.onReady(async (info) => {
	configureMarkdown();
	const host = resolveHost(info);
	try {
		const response = await fetch("/config");
		const cfg = await response.json();
		chatConfig = {
			url: cfg.chatBridgeUrl || "",
			token: cfg.chatBridgeToken || "",
		};
		initChat();
		connect(host, cfg.host, cfg.token);
		setStatus("connecting", "正在连接");
	} catch (error) {
		setStatus("error", "配置读取失败");
		setChatState(error.message || String(error));
	}
});

function configureMarkdown() {
	if (!window.marked) return;
	window.marked.setOptions({
		breaks: true,
		gfm: true,
	});
}

function resolveHost(info) {
	if (info.host === Office.HostType.Word) return "word";
	if (info.host === Office.HostType.Excel) return "excel";
	if (info.host === Office.HostType.PowerPoint) return "ppt";
	return "word";
}

function connect(actualHost, configuredHost, token) {
	if (actualHost !== configuredHost) {
		setStatus("error", "宿主不匹配");
		setChatState(`当前打开在 ${hostLabel(actualHost)}，桥接服务配置为 ${hostLabel(configuredHost)}。`);
		return;
	}
	socket = new WebSocket(`wss://${location.host}/ws?host=${configuredHost}&token=${encodeURIComponent(token)}`);
	socket.onopen = () => {
		reconnectDelay = 500;
		setStatus("connected", "已连接");
	};
	socket.onclose = () => {
		setStatus("connecting", "正在重连");
		setChatState("连接已断开，正在重新连接本地桥接服务...");
		setTimeout(() => connect(actualHost, configuredHost, token), reconnectDelay);
		reconnectDelay = Math.min(reconnectDelay * 2, 5000);
	};
	socket.onmessage = async (event) => {
		const msg = JSON.parse(event.data);
		try {
			const out = await dispatch(actualHost, msg.op, msg.args || {});
			socket.send(JSON.stringify({ id: msg.id, ok: true, ...out }));
		} catch (error) {
			socket.send(JSON.stringify({ id: msg.id, ok: false, message: error.message || String(error) }));
		}
	};
}

function setStatus(_state, label) {
	const labelEl = document.getElementById("status-label");
	if (labelEl) labelEl.textContent = label;
}

function hostLabel(host) {
	if (host === "word") return "Word";
	if (host === "excel") return "Excel";
	if (host === "ppt") return "PowerPoint";
	return host || "Office";
}

function initChat() {
	const form = document.getElementById("composer");
	const input = document.getElementById("chat-input");
	const abortButton = document.getElementById("abort-button");
	const newChatButton = document.getElementById("new-chat-button");
	if (form) {
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			void sendChatPrompt();
		});
	}
	if (input) {
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				void sendChatPrompt();
			}
		});
	}
	if (abortButton) {
		abortButton.addEventListener("click", () => {
			void abortChat();
		});
	}
	if (newChatButton) {
		newChatButton.addEventListener("click", () => {
			void createNewConversation();
		});
	}
	if (!chatConfig?.url || !chatConfig?.token) {
		setChatState("需要更新插件");
		renderChatEmpty("请在插件管理中对 Word 实时协同执行一次“安装 / 更新”，以启用侧边栏聊天。");
		return;
	}
	setChatState("正在同步");
	setComposerEnabled(true);
	void fetchChatSnapshot();
	connectChatEvents();
	chatPollTimer = setInterval(() => {
		void fetchChatSnapshot();
	}, 3000);
}

async function fetchChatSnapshot() {
	if (!chatConfig?.url || !chatConfig?.token) return;
	try {
		const response = await fetch(`${chatConfig.url}/snapshot?token=${encodeURIComponent(chatConfig.token)}`);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		applyChatSnapshot(await response.json());
	} catch (error) {
		setChatState(`聊天桥未连接：${error.message || String(error)}`);
	}
}

function connectChatEvents() {
	if (!chatConfig?.url || !chatConfig?.token) return;
	try {
		const wsUrl = chatConfig.url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
		chatEvents = new WebSocket(`${wsUrl}/events?token=${encodeURIComponent(chatConfig.token)}`);
		chatEvents.onmessage = (event) => {
			const msg = JSON.parse(event.data);
			if (msg.type === "snapshot") applyChatSnapshot(msg.snapshot);
		};
		chatEvents.onclose = () => {
			setTimeout(connectChatEvents, 2500);
		};
	} catch {
		// Polling still keeps the sidebar usable when WebSocket is unavailable.
	}
}

async function sendChatPrompt() {
	const input = document.getElementById("chat-input");
	const text = input?.value.trim() || "";
	if (!text || !chatConfig?.url || !chatConfig?.token) return;
	setChatState("发送中");
	setComposerEnabled(false);
	try {
		const response = await fetch(`${chatConfig.url}/prompt?token=${encodeURIComponent(chatConfig.token)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: text }),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		if (input) input.value = "";
		applyChatSnapshot(await response.json());
	} catch (error) {
		setChatState(`发送失败：${error.message || String(error)}`);
	} finally {
		setComposerEnabled(true);
	}
}

async function createNewConversation() {
	if (!chatConfig?.url || !chatConfig?.token) return;
	setChatState("正在新建会话");
	try {
		const response = await fetch(`${chatConfig.url}/new-conversation?token=${encodeURIComponent(chatConfig.token)}`, {
			method: "POST",
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		applyChatSnapshot(await response.json());
	} catch (error) {
		setChatState(`新建失败：${error.message || String(error)}`);
	}
}

async function abortChat() {
	if (!chatConfig?.url || !chatConfig?.token) return;
	try {
		const response = await fetch(`${chatConfig.url}/abort?token=${encodeURIComponent(chatConfig.token)}`, {
			method: "POST",
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		applyChatSnapshot(await response.json());
	} catch (error) {
		setChatState(`停止失败：${error.message || String(error)}`);
	}
}

function applyChatSnapshot(snapshot) {
	latestChatSnapshot = snapshot;
	renderChat(snapshot);
	setChatState(snapshot.isRunning ? "助手正在回复" : "已同步当前会话");
	setComposerEnabled(true);
	const abortButton = document.getElementById("abort-button");
	if (abortButton) abortButton.disabled = !snapshot.isRunning;
	const banner = document.getElementById("confirmation-banner");
	if (banner) banner.classList.toggle("visible", Number(snapshot.pendingConfirmationCount || 0) > 0);
}

function renderChat(snapshot) {
	const messagesEl = document.getElementById("messages");
	if (!messagesEl) return;
	const shouldStickToBottom = isNearBottom(messagesEl);
	const messages = Array.isArray(snapshot.messages) ? [...snapshot.messages] : [];
	if (snapshot.streamingText) {
		messages.push({
			id: "streaming",
			role: "assistant",
			text: snapshot.streamingText,
			timestamp: Date.now(),
			order: Number.MAX_SAFE_INTEGER,
		});
	}
	messagesEl.innerHTML = "";
	if (!messages.length) {
		renderChatEmpty("当前会话还没有消息。可以直接在下方输入。");
		return;
	}
	for (const message of messages) {
		const item = document.createElement("div");
		item.className = `message ${message.role || "assistant"}`;
		item.innerHTML = renderMarkdown(message.text || "");
		messagesEl.appendChild(item);
	}
	if (shouldStickToBottom) {
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}
}

function renderChatEmpty(text) {
	const messagesEl = document.getElementById("messages");
	if (!messagesEl) return;
	messagesEl.innerHTML = "";
	const empty = document.createElement("p");
	empty.className = "empty";
	empty.textContent = text;
	messagesEl.appendChild(empty);
}

function renderMarkdown(text) {
	const source = stripUnsafeHtml(text || "");
	if (!window.marked) {
		return escapeHtml(source).replace(/\n/g, "<br />");
	}
	return window.marked.parse(source, { async: false, mangle: false, headerIds: false });
}

function stripUnsafeHtml(value) {
	return value.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "").replace(/\son\w+=(["']).*?\1/gi, "");
}

function escapeHtml(value) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function isNearBottom(element) {
	return element.scrollHeight - element.scrollTop - element.clientHeight < 48;
}

function setChatState(text) {
	const el = document.getElementById("chat-state");
	if (el) el.textContent = text;
}

function setComposerEnabled(enabled) {
	const sendButton = document.getElementById("send-button");
	const input = document.getElementById("chat-input");
	const newChatButton = document.getElementById("new-chat-button");
	if (sendButton) sendButton.disabled = !enabled || !chatConfig?.url || !chatConfig?.token;
	if (input) input.disabled = !enabled;
	if (newChatButton) newChatButton.disabled = !chatConfig?.url || !chatConfig?.token;
}

async function dispatch(host, op, args) {
	if (host === "word") return wordOp(op, args);
	if (host === "excel") throw new Error("Excel live add-in operations are not implemented yet.");
	if (host === "ppt") throw new Error("PowerPoint live add-in operations are not implemented yet.");
	throw new Error(`Unsupported Office host: ${host}`);
}

async function wordOp(op, args) {
	return Word.run(async (ctx) => {
		const body = ctx.document.body;
		const selection = ctx.document.getSelection();
		switch (op) {
			case "read_state":
				return { state: await readWordState(ctx) };
			case "read_document": {
				body.load("text");
				await ctx.sync();
				const max = Number.isFinite(args.maxChars) ? args.maxChars : 20000;
				return { result: { text: body.text.slice(0, max), truncated: body.text.length > max } };
			}
			case "set_selection": {
				const results = body.search(args.find, { matchCase: false });
				results.load("items");
				await ctx.sync();
				if (!results.items.length) throw new Error(`Text not found: ${args.find}`);
				results.items[0].select();
				await ctx.sync();
				return { result: { matched: true }, state: await readWordState(ctx) };
			}
			case "insert_text": {
				const location = args.location || "selection";
				if (location === "selection") {
					selection.insertText(args.text, Word.InsertLocation.replace);
				} else {
					body.insertText(args.text, location === "start" ? Word.InsertLocation.start : Word.InsertLocation.end);
				}
				await ctx.sync();
				return { state: await readWordState(ctx) };
			}
			case "replace_selection":
				selection.insertText(args.text, Word.InsertLocation.replace);
				await ctx.sync();
				return { state: await readWordState(ctx) };
			case "replace_all": {
				const results = body.search(args.find, { matchCase: !!args.matchCase });
				results.load("items");
				await ctx.sync();
				for (const item of results.items) {
					item.insertText(args.replace, Word.InsertLocation.replace);
				}
				await ctx.sync();
				return { result: { count: results.items.length }, state: await readWordState(ctx) };
			}
			case "format_selection": {
				const font = selection.font;
				if (args.bold !== undefined) font.bold = args.bold;
				if (args.italic !== undefined) font.italic = args.italic;
				if (args.font) font.name = args.font;
				if (args.size) font.size = args.size;
				if (args.color) font.color = args.color;
				if (args.highlight) font.highlightColor = args.highlight;
				await ctx.sync();
				return { state: await readWordState(ctx) };
			}
			case "apply_style": {
				const style = Word.BuiltInStyleName[args.style] || args.style;
				selection.styleBuiltIn = style;
				await ctx.sync();
				return { state: await readWordState(ctx) };
			}
			case "insert_html": {
				const location = args.location || "selection";
				if (location === "selection") {
					selection.insertHtml(args.html, Word.InsertLocation.replace);
				} else {
					body.insertHtml(args.html, location === "start" ? Word.InsertLocation.start : Word.InsertLocation.end);
				}
				await ctx.sync();
				return { state: await readWordState(ctx) };
			}
			default:
				throw new Error(`Unknown Word operation: ${op}`);
		}
	});
}

async function readWordState(ctx) {
	const selection = ctx.document.getSelection();
	const body = ctx.document.body;
	const paragraphs = body.paragraphs;
	selection.load("text,style");
	paragraphs.load("items");
	body.load("text");
	await ctx.sync();
	return {
		selectionText: selection.text,
		selectionStyle: selection.style,
		paragraphCount: paragraphs.items.length,
		bodyLength: body.text.length,
	};
}
