const bridgeUrlInput = document.querySelector("#bridgeUrl");
const tokenInput = document.querySelector("#token");
const saveButton = document.querySelector("#save");
const statusEl = document.querySelector("#status");

async function send(message) {
	return await chrome.runtime.sendMessage(message);
}

async function load() {
	const status = await send({ type: "browserMcpStatus" });
	if (!status.ok) {
		statusEl.textContent = status.message || "Failed to read extension status.";
		return;
	}
	bridgeUrlInput.value = status.settings.bridgeUrl || "http://127.0.0.1:17890";
	tokenInput.value = status.settings.token || "";
	statusEl.textContent = JSON.stringify(
		{
			clientId: status.clientId,
			browser: status.browser,
			polling: status.polling,
			bridgeUrl: status.settings.bridgeUrl,
			tokenConfigured: Boolean(status.settings.token),
		},
		null,
		2,
	);
}

saveButton.addEventListener("click", async () => {
	await send({
		type: "browserMcpSaveSettings",
		settings: {
			bridgeUrl: bridgeUrlInput.value.trim() || "http://127.0.0.1:17890",
			token: tokenInput.value,
		},
	});
	await load();
});

void load();
