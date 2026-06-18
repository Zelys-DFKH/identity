import type { GitHubEvent, IdentifyFlag } from "../types";

export function detectZeroReposActivity(
	reposCount: number,
	foreignEvents: GitHubEvent[],
	events: GitHubEvent[],
): IdentifyFlag[] {
	if (reposCount === 0 && foreignEvents.length === events.length && events.length >= 20) {
		return [{
			label: "Only active on other people's repos",
			points: 50,
			detail: `No personal repos, all ${events.length} events are on repos they don't own`,
		}];
	}
	return [];
}
