import dayjs from "dayjs";
import { CONFIG, LABEL_ISSUE_COMMENT_SPAM, LABEL_PR_COMMENT_SPAM } from "../config";
import { findDensestBurst } from "../utils";
import type { GitHubEvent, IdentifyFlag } from "../types";

export function detectCommentSpam(events: GitHubEvent[]): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];

	if (events.length < CONFIG.MIN_EVENTS_FOR_ANALYSIS) {
		return flags;
	}

	// Issue comment spam detection (multiple comments across different repos in short time)
	const issueCommentEvents = events.filter(
		(e) => e.type === "IssueCommentEvent",
	);

	if (issueCommentEvents.length >= CONFIG.ISSUE_COMMENT_MIN_FOR_SPRAY) {
		const burst = findDensestBurst(
			issueCommentEvents,
			(e) => e.repo?.name,
			CONFIG.ISSUE_COMMENT_SPAM_WINDOW_MINUTES,
		);
		const maxDistinctReposInWindow = burst.maxKeyCount;
		const maxReposWindowStartIdx = burst.startIdx;
		const maxReposWindowEndIdx = burst.endIdx;

		if (maxDistinctReposInWindow >= CONFIG.ISSUE_COMMENT_SPRAY_EXTREME) {
			const commentTimestamps = issueCommentEvents
				.map((e) => ({ time: dayjs(e.created_at) }))
				.sort((a, b) => a.time.valueOf() - b.time.valueOf());
			const windowStart = commentTimestamps[maxReposWindowStartIdx]?.time;
			const windowEnd = commentTimestamps[maxReposWindowEndIdx]?.time;
			const commentsInWindow = maxReposWindowEndIdx - maxReposWindowStartIdx + 1;
			const timeSpanMinutes =
				windowEnd && windowStart
					? Math.round(windowEnd.diff(windowStart, "minute", true))
					: 0;
			flags.push({
				label: LABEL_ISSUE_COMMENT_SPAM,
				points: CONFIG.POINTS_ISSUE_COMMENT_SPRAY_EXTREME,
				amplifiable: true,
				detail: `${commentsInWindow} comments to ${maxDistinctReposInWindow} different repos in just ${timeSpanMinutes} minute${timeSpanMinutes === 1 ? "" : "s"}`,
			});
		} else if (maxDistinctReposInWindow >= CONFIG.ISSUE_COMMENT_SPRAY_HIGH) {
			const commentTimestamps = issueCommentEvents
				.map((e) => ({ time: dayjs(e.created_at) }))
				.sort((a, b) => a.time.valueOf() - b.time.valueOf());
			const windowStart = commentTimestamps[maxReposWindowStartIdx]?.time;
			const windowEnd = commentTimestamps[maxReposWindowEndIdx]?.time;
			const commentsInWindow = maxReposWindowEndIdx - maxReposWindowStartIdx + 1;
			const timeSpanMinutes =
				windowEnd && windowStart
					? Math.round(windowEnd.diff(windowStart, "minute", true))
					: 0;
			flags.push({
				label: "High comment frequency across repos",
				points: CONFIG.POINTS_ISSUE_COMMENT_SPRAY_HIGH,
				amplifiable: true,
				detail: `${commentsInWindow} comments to ${maxDistinctReposInWindow} different repos in just ${timeSpanMinutes} minute${timeSpanMinutes === 1 ? "" : "s"}`,
			});
		}
	}

	// PR comment spam detection (multiple review comments across different PRs/repos in short time)
	const prCommentEvents = events.filter(
		(e) => e.type === "PullRequestReviewCommentEvent",
	);

	if (prCommentEvents.length >= CONFIG.PR_COMMENT_MIN_FOR_SPRAY) {
		const burst = findDensestBurst(
			prCommentEvents,
			(e) => {
				const repoName = e.repo?.name;
				const prNumber = e.payload?.pull_request?.number;
				if (repoName && prNumber) {
					return `${repoName}#${prNumber}`;
				}
				return repoName;
			},
			CONFIG.PR_COMMENT_SPAM_WINDOW_MINUTES,
		);
		const maxDistinctPRsInWindow = burst.maxKeyCount;
		const maxPRsWindowStartIdx = burst.startIdx;
		const maxPRsWindowEndIdx = burst.endIdx;

		if (maxDistinctPRsInWindow >= CONFIG.PR_COMMENT_SPRAY_EXTREME) {
			const prCommentTimestamps = prCommentEvents
				.map((e) => ({ time: dayjs(e.created_at) }))
				.sort((a, b) => a.time.valueOf() - b.time.valueOf());
			const windowStart = prCommentTimestamps[maxPRsWindowStartIdx]?.time;
			const windowEnd = prCommentTimestamps[maxPRsWindowEndIdx]?.time;
			const commentsInWindow = maxPRsWindowEndIdx - maxPRsWindowStartIdx + 1;
			const timeSpanMinutes =
				windowEnd && windowStart
					? Math.round(windowEnd.diff(windowStart, "minute", true))
					: 0;
			flags.push({
				label: LABEL_PR_COMMENT_SPAM,
				points: CONFIG.POINTS_PR_COMMENT_SPRAY_EXTREME,
				amplifiable: true,
				detail: `${commentsInWindow} comments on ${maxDistinctPRsInWindow} different PRs in just ${timeSpanMinutes} minute${timeSpanMinutes === 1 ? "" : "s"}`,
			});
		} else if (maxDistinctPRsInWindow >= CONFIG.PR_COMMENT_SPRAY_HIGH) {
			const prCommentTimestamps = prCommentEvents
				.map((e) => ({ time: dayjs(e.created_at) }))
				.sort((a, b) => a.time.valueOf() - b.time.valueOf());
			const windowStart = prCommentTimestamps[maxPRsWindowStartIdx]?.time;
			const windowEnd = prCommentTimestamps[maxPRsWindowEndIdx]?.time;
			const commentsInWindow = maxPRsWindowEndIdx - maxPRsWindowStartIdx + 1;
			const timeSpanMinutes =
				windowEnd && windowStart
					? Math.round(windowEnd.diff(windowStart, "minute", true))
					: 0;
			flags.push({
				label: "High PR comment frequency",
				points: CONFIG.POINTS_PR_COMMENT_SPRAY_HIGH,
				amplifiable: true,
				detail: `${commentsInWindow} comments on ${maxDistinctPRsInWindow} different PRs in just ${timeSpanMinutes} minute${timeSpanMinutes === 1 ? "" : "s"}`,
			});
		}
	}

	return flags;
}
