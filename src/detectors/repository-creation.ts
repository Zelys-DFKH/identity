import dayjs from "dayjs";
import { CONFIG } from "../config";
import type { GitHubEvent, IdentifyFlag } from "../types";
import { findMaxEventsInWindow } from "../utils";

export function detectRepositoryCreationBurst(
	events: GitHubEvent[],
): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];
	if (events.length < CONFIG.MIN_EVENTS_FOR_ANALYSIS) return flags;

	const createEvents = events.filter((e) => e.type === "CreateEvent" && e.payload?.ref_type === "repository");
	if (createEvents.length >= CONFIG.CREATE_EVENTS_MIN) {
		const createTimestamps = createEvents
			.map((e) => dayjs(e.created_at))
			.sort((a, b) => a.valueOf() - b.valueOf());
		const maxCreatesInWindow = findMaxEventsInWindow(createTimestamps, 24);

		if (maxCreatesInWindow >= CONFIG.CREATE_BURST_EXTREME) {
			flags.push({
				label: "Concentrated repository creation",
				points: CONFIG.POINTS_CREATE_BURST_EXTREME,
				amplifiable: true,
				detail: `${maxCreatesInWindow} repositories created in a short timeframe (within 24 hours)`,
			});
		} else if (maxCreatesInWindow >= CONFIG.CREATE_BURST_HIGH) {
			flags.push({
				label: "Frequent repository creation",
				points: CONFIG.POINTS_CREATE_BURST_HIGH,
				amplifiable: true,
				detail: `${maxCreatesInWindow} repositories created in a short timeframe (within 24 hours)`,
			});
		}
	}

	return flags;
}
