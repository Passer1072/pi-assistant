import { lazy, Suspense } from "react";
import type { FlowGraphTimelineData } from "../../../src/shared/types.ts";

// Lazy-load the bubble (and with it ReactFlow / @xyflow) so the heavy graph library
// only enters the bundle when an automation conversation actually shows a flowchart —
// it stays out of the main chat path that every session loads.
const FlowchartProgressBubble = lazy(() =>
	import("./FlowchartProgressBubble.tsx").then((module) => ({ default: module.FlowchartProgressBubble })),
);

/** Sticky, pinned flowchart panel for automation conversations. */
export function FlowchartProgressPanel({ data }: { data: FlowGraphTimelineData }) {
	return (
		<div className="flowchart-progress-panel">
			<Suspense
				fallback={
					<div className="flowchart-progress">
						<div className="flowchart-progress-graph" />
					</div>
				}
			>
				<FlowchartProgressBubble data={data} />
			</Suspense>
		</div>
	);
}
