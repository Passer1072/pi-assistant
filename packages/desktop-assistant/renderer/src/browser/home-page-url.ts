/**
 * Decide what an omnibox / home-page search-box entry should navigate to.
 *
 * - Empty input returns "" (caller should ignore it).
 * - Anything with an explicit URL scheme (http:, https:, file:, about:, ...) is used as-is.
 * - Inputs that look like a bare host/domain (a dot with no spaces, "localhost", or a host:port)
 *   are treated as URLs and prefixed with https://.
 * - Everything else is treated as a search query and substituted into the search template.
 */
export function resolveOmniboxUrl(input: string, searchTemplate: string): string {
	const trimmed = input.trim();
	if (!trimmed) return "";
	if (hasUrlScheme(trimmed)) return trimmed;
	if (looksLikeHost(trimmed)) return `https://${trimmed}`;
	return buildSearchUrl(trimmed, searchTemplate);
}

function hasUrlScheme(value: string): boolean {
	const match = /^[a-z][a-z0-9+.-]*:(.?)/i.exec(value);
	if (!match) return false;
	// Distinguish a real scheme (about:, https://, mailto:foo) from a host:port (localhost:3000):
	// a digit immediately after the colon means it is a port, not a scheme.
	return !/\d/.test(match[1]);
}

function looksLikeHost(value: string): boolean {
	if (/\s/.test(value)) return false;
	if (/^localhost(:\d+)?(\/.*)?$/i.test(value)) return true;
	// host[:port][/path] with at least one dot in the host label (e.g. example.com, a.b.co/x).
	return /^[^/\s.]+(\.[^/\s.]+)+(:\d+)?(\/.*)?$/.test(value);
}

function buildSearchUrl(query: string, searchTemplate: string): string {
	const encoded = encodeURIComponent(query);
	if (searchTemplate.includes("%s")) return searchTemplate.replace(/%s/g, encoded);
	return `https://www.google.com/search?q=${encoded}`;
}
