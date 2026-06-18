import { CONFIG, LABEL_IMPOSSIBLE_THROUGHPUT } from "../config";
import type { GitHubEvent, IdentifyFlag } from "../types";

const WRITE_TYPES = new Set([
	"PushEvent", "PullRequestEvent", "IssueCommentEvent", "CreateEvent", "DeleteEvent",
	"PullRequestReviewEvent", "PullRequestReviewCommentEvent", "CommitCommentEvent",
	"IssuesEvent", "ReleaseEvent",
]);

// 150+ write events in a 2-hour window is physically beyond what a person can do — flags machine-level pace regardless of event type
export function detectImpossibleThroughput(events: GitHubEvent[]): IdentifyFlag[] {
	const writeEvents = events
		.filter((e) => e.type && WRITE_TYPES.has(e.type) && e.created_at)
		.map((e) => ({ ts: new Date(e.created_at!).getTime() }))
		.filter((e) => !Number.isNaN(e.ts))
		.sort((a, b) => a.ts - b.ts);
	if (writeEvents.length < CONFIG.THROUGHPUT_CEILING) return [];
	let maxCount = 0;
	let j = 0;
	for (let i = 0; i < writeEvents.length; i++) {
		if (j < i) j = i;
		while (j < writeEvents.length && writeEvents[j].ts - writeEvents[i].ts < CONFIG.THROUGHPUT_WINDOW_MS) j++;
		const count = j - i;
		if (count > maxCount) maxCount = count;
	}
	if (maxCount < CONFIG.THROUGHPUT_CEILING) return [];
	const windowHours = CONFIG.THROUGHPUT_WINDOW_MS / 3600000;
	return [{
		label: LABEL_IMPOSSIBLE_THROUGHPUT,
		points: CONFIG.POINTS_IMPOSSIBLE_THROUGHPUT,
		amplifiable: true,
		detail: `${maxCount} write events in a ${windowHours}-hour window`,
	}];
}
