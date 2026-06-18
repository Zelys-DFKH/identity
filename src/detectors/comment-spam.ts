import dayjs from "dayjs";
import { CONFIG, LABEL_ISSUE_COMMENT_SPAM, LABEL_PR_COMMENT_SPAM } from "../config";
import { findDensestBurst, sortByDate, filterByType } from "../utils";
import type { GitHubEvent, IdentifyFlag } from "../types";

function checkSpray(
	events: GitHubEvent[],
	keyFn: (e: GitHubEvent) => string | undefined,
	windowMinutes: number,
	minForSpray: number,
	tiers: [threshold: number, label: string, points: number][],
	targetText: (keyCount: number) => string,
): IdentifyFlag[] {
	if (events.length < minForSpray) return [];
	const burst = findDensestBurst(events, keyFn, windowMinutes);
	const tier = tiers.find(([threshold]) => burst.maxKeyCount >= threshold);
	if (!tier) return [];
	const [, label, points] = tier;
	const timestamps = sortByDate(events.map((e) => ({ time: dayjs(e.created_at) })));
	const start = timestamps[burst.startIdx]?.time;
	const end = timestamps[burst.endIdx]?.time;
	const mins = end && start ? Math.round(end.diff(start, "minute", true)) : 0;
	const count = burst.endIdx - burst.startIdx + 1;
	return [{
		label,
		points,
		amplifiable: true,
		detail: `${count} comments ${targetText(burst.maxKeyCount)} in just ${mins} minute${mins === 1 ? "" : "s"}`,
	}];
}

export function detectCommentSpam(events: GitHubEvent[]): IdentifyFlag[] {
	if (events.length < CONFIG.MIN_EVENTS_FOR_ANALYSIS) return [];
	return [
		...checkSpray(
			filterByType(events, "IssueCommentEvent"),
			(e) => e.repo?.name,
			CONFIG.ISSUE_COMMENT_SPAM_WINDOW_MINUTES,
			CONFIG.ISSUE_COMMENT_MIN_FOR_SPRAY,
			[
				[CONFIG.ISSUE_COMMENT_SPRAY_EXTREME, LABEL_ISSUE_COMMENT_SPAM, CONFIG.POINTS_ISSUE_COMMENT_SPRAY_EXTREME],
				[CONFIG.ISSUE_COMMENT_SPRAY_HIGH, "High comment frequency across repos", CONFIG.POINTS_ISSUE_COMMENT_SPRAY_HIGH],
			],
			(n) => `to ${n} different repos`,
		),
		...checkSpray(
			filterByType(events, "PullRequestReviewCommentEvent"),
			(e) => {
				const repoName = e.repo?.name;
				const prNumber = e.payload?.pull_request?.number;
				return repoName && prNumber ? `${repoName}#${prNumber}` : repoName;
			},
			CONFIG.PR_COMMENT_SPAM_WINDOW_MINUTES,
			CONFIG.PR_COMMENT_MIN_FOR_SPRAY,
			[
				[CONFIG.PR_COMMENT_SPRAY_EXTREME, LABEL_PR_COMMENT_SPAM, CONFIG.POINTS_PR_COMMENT_SPRAY_EXTREME],
				[CONFIG.PR_COMMENT_SPRAY_HIGH, "High PR comment frequency", CONFIG.POINTS_PR_COMMENT_SPRAY_HIGH],
			],
			(n) => `on ${n} different PRs`,
		),
	];
}
