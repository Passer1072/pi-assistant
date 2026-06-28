import type { DynamicWindowFileNode } from "../../../src/shared/types.ts";

/**
 * Fold a flat list of file leaves (each carrying a full path) into a folder tree.
 * Single-child folder chains are collapsed (e.g. `C:\Users\me\report`) so deep
 * Windows paths stay readable. Pure — no disk access; the renderer calls it.
 */
export function buildFileTree(items: DynamicWindowFileNode[]): DynamicWindowFileNode[] {
	const roots: DynamicWindowFileNode[] = [];
	const folders = new Map<string, DynamicWindowFileNode>();

	for (const item of items) {
		const segments = item.path.split(/[\\/]+/).filter(Boolean);
		if (segments.length === 0) continue;
		let children = roots;
		let accumulated = "";
		for (let index = 0; index < segments.length - 1; index += 1) {
			accumulated = accumulated ? `${accumulated}\\${segments[index]}` : segments[index];
			const key = accumulated.toLowerCase();
			let folder = folders.get(key);
			if (!folder) {
				folder = { name: segments[index], path: accumulated, isDirectory: true, children: [] };
				folders.set(key, folder);
				children.push(folder);
			}
			children = folder.children as DynamicWindowFileNode[];
		}
		children.push({ ...item, name: segments[segments.length - 1] });
	}

	return roots.map(collapseChain);
}

/** Merge a folder with its sole child folder, recursively, to shorten the tree. */
function collapseChain(node: DynamicWindowFileNode): DynamicWindowFileNode {
	if (!node.isDirectory || !node.children) return node;
	let current = node;
	while (
		current.isDirectory &&
		current.children &&
		current.children.length === 1 &&
		current.children[0].isDirectory
	) {
		const child = current.children[0];
		current = { ...child, name: `${current.name}\\${child.name}` };
	}
	return {
		...current,
		children: current.children ? current.children.map(collapseChain) : undefined,
	};
}
