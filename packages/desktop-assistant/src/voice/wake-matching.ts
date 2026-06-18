export function scoreWakeWord(candidate: string, wakeWord: string): number {
	const normalizedCandidate = normalizeWakeText(candidate);
	const normalizedWakeWord = normalizeWakeText(wakeWord);
	if (!normalizedCandidate || !normalizedWakeWord) return 0;
	if (normalizedCandidate.includes(normalizedWakeWord)) return 1;
	const candidateTokens = buildWakeCandidates(normalizedCandidate);
	const wakeTokens = buildWakeCandidates(normalizedWakeWord);
	let best = 0;
	for (const candidateToken of candidateTokens) {
		for (const wakeToken of wakeTokens) {
			best = Math.max(best, similarity(candidateToken, wakeToken));
		}
	}
	return best;
}

function buildWakeCandidates(text: string): string[] {
	const aliases = new Set<string>([text]);
	if (text === "hi" || text === "hey" || text === "hai") {
		aliases.add("嗨");
		aliases.add("嘿");
		aliases.add("海");
	}
	if (text === "嗨" || text === "嘿" || text === "海" || text === "还" || text === "害") {
		aliases.add("hi");
		aliases.add("hey");
		aliases.add("hai");
	}
	if (text === "hipi" || text === "hipei" || text === "haipi") {
		aliases.add("嗨派");
		aliases.add("海派");
	}
	if (text.includes("嗨派") || text.includes("海派") || text.includes("黑派")) {
		aliases.add("hipi");
	}
	return [...aliases];
}

function normalizeWakeText(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{Letter}\p{Number}]+/gu, "")
		.replace(/π/g, "pi")
		.trim();
}

function similarity(left: string, right: string): number {
	const maxLength = Math.max(left.length, right.length);
	if (maxLength === 0) return 1;
	return 1 - levenshtein(left, right) / maxLength;
}

function levenshtein(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	const current = Array.from({ length: right.length + 1 }, () => 0);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		current[0] = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
			current[rightIndex] = Math.min(
				current[rightIndex - 1] + 1,
				previous[rightIndex] + 1,
				previous[rightIndex - 1] + cost,
			);
		}
		for (let index = 0; index < previous.length; index += 1) {
			previous[index] = current[index];
		}
	}
	return previous[right.length] ?? 0;
}
