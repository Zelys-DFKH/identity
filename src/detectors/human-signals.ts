import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { CONFIG } from "../config";
import type { GitHubEvent, IdentifyFlag, IdentifyProfile } from "../types";
import { isExternalEvent, msToDays } from "../utils";

dayjs.extend(utc);

type Tier = [threshold: number, label: string, points: number];

function tieredFlag(
	value: number,
	detail: string,
	tiers: Tier[],
	extra?: Partial<IdentifyFlag>,
): IdentifyFlag | undefined {
	const tier = tiers.find(([t]) => value >= t);
	return tier ? { label: tier[1], points: tier[2], detail, ...extra } : undefined;
}

function filterByTypeAndExternal(events: GitHubEvent[], type: string, accountName: string): GitHubEvent[] {
	return events.filter((e) => e.type === type && isExternalEvent(e, accountName));
}

export function detectMergedContributions(
	events: GitHubEvent[],
	accountName: string,
): IdentifyFlag[] {
	const mergedPRRepos = new Set<string>();
	for (const e of events) {
		if (e.type !== "PullRequestEvent") continue;
		const action = e.payload?.action;
		const isMerged = action === "merged" || (action === "closed" && e.payload?.pull_request?.merged === true);
		if (!isMerged) continue;
		if (isExternalEvent(e, accountName) && e.repo?.name) mergedPRRepos.add(e.repo.name);
	}
	const flag = tieredFlag(mergedPRRepos.size, `Merged PRs in ${mergedPRRepos.size} external repositories`, [
		[CONFIG.MERGED_PR_REPOS_HIGH, "Established contributor", CONFIG.POINTS_ESTABLISHED_CONTRIBUTOR_HIGH],
		[CONFIG.MERGED_PR_REPOS_MIN, "External contributor", CONFIG.POINTS_ESTABLISHED_CONTRIBUTOR],
	]);
	return flag ? [flag] : [];
}

export function detectReviewActivity(
	events: GitHubEvent[],
	accountName: string,
): IdentifyFlag[] {
	const prReviews = filterByTypeAndExternal(events, "PullRequestReviewEvent", accountName);
	const flag = tieredFlag(prReviews.length, `${prReviews.length} PR reviews on external repositories`, [
		[CONFIG.REVIEW_EVENTS_HIGH, "Active code reviewer", CONFIG.POINTS_REVIEW_ACTIVITY_HIGH],
		[CONFIG.REVIEW_EVENTS_BASE, "Code reviewer", CONFIG.POINTS_REVIEW_ACTIVITY],
	]);
	return flag ? [flag] : [];
}

export function detectReviewCommentActivity(
	events: GitHubEvent[],
	accountName: string,
): IdentifyFlag[] {
	const prComments = filterByTypeAndExternal(events, "PullRequestReviewCommentEvent", accountName);
	const flag = tieredFlag(prComments.length, `${prComments.length} inline review comments on external repositories`, [
		[CONFIG.REVIEW_COMMENT_EVENTS_HIGH, "Inline review commenter", CONFIG.POINTS_REVIEW_COMMENTS_HIGH],
		[CONFIG.REVIEW_COMMENT_EVENTS_BASE, "Inline review commenter", CONFIG.POINTS_REVIEW_COMMENTS],
	]);
	return flag ? [flag] : [];
}

export function detectDormancyGap(events: GitHubEvent[]): IdentifyFlag[] {
	if (events.length < 2) return [];
	const timestamps = events
		.map((e) => e.created_at)
		.filter((t): t is string => !!t)
		.map((t) => dayjs.utc(t).valueOf())
		.sort((a, b) => a - b);
	if (timestamps.length < 2) return [];
	let maxGapDays = 0;
	for (let i = 1; i < timestamps.length; i++) {
		const gap = msToDays(timestamps[i] - timestamps[i - 1]);
		if (gap > maxGapDays) maxGapDays = gap;
	}
	const flag = tieredFlag(maxGapDays, `${Math.round(maxGapDays)}-day gap in activity`, [
		[CONFIG.DORMANCY_GAP_LONG_DAYS, "Extended dormancy period", CONFIG.POINTS_DORMANCY_GAP_LONG],
		[CONFIG.DORMANCY_GAP_DAYS, "Dormancy gap", CONFIG.POINTS_DORMANCY_GAP],
	]);
	return flag ? [flag] : [];
}

export function detectGistActivity(events: GitHubEvent[]): IdentifyFlag[] {
	if (!events.some((e) => e.type === "GistEvent")) return [];
	return [{ label: "Gist activity", points: CONFIG.POINTS_GIST_ACTIVITY, detail: "Account has gist activity" }];
}

export function detectPRIterationCycles(
	events: GitHubEvent[],
	accountName: string,
): IdentifyFlag[] {
	const syncRepos = new Set<string>();
	for (const e of events) {
		if (e.type !== "PullRequestEvent" || e.payload?.action !== "synchronize") continue;
		if (isExternalEvent(e, accountName) && e.repo?.name) syncRepos.add(e.repo.name);
	}
	const flag = tieredFlag(syncRepos.size, `PR iteration cycles in ${syncRepos.size} external repositories`, [
		[CONFIG.PR_SYNC_REPOS_HIGH, "Iterated contributions", CONFIG.POINTS_PR_SYNC_HIGH],
		[CONFIG.PR_SYNC_REPOS_BASE, "Iterated contributions", CONFIG.POINTS_PR_SYNC_BASE],
	]);
	return flag ? [flag] : [];
}

export function detectLongSpanEngagement(
	events: GitHubEvent[],
	accountName: string,
): IdentifyFlag[] {
	const repoSpans = new Map<string, { first: number; last: number }>();
	for (const e of events) {
		if (!e.repo?.name || !e.created_at || !isExternalEvent(e, accountName)) continue;
		const ts = dayjs.utc(e.created_at).valueOf();
		const existing = repoSpans.get(e.repo.name);
		if (!existing) {
			repoSpans.set(e.repo.name, { first: ts, last: ts });
		} else {
			if (ts < existing.first) existing.first = ts;
			if (ts > existing.last) existing.last = ts;
		}
	}
	let longSpanCount = 0;
	for (const { first, last } of repoSpans.values()) {
		const spanDays = msToDays(last - first);
		if (spanDays > 0 && spanDays >= CONFIG.REPO_SPAN_MIN_DAYS) longSpanCount++;
	}
	const flag = tieredFlag(longSpanCount, `${longSpanCount} external repositories with ${CONFIG.REPO_SPAN_MIN_DAYS}+ day engagement span`, [
		[CONFIG.REPO_SPAN_HIGH_COUNT, "Long-span engagement", CONFIG.POINTS_REPO_SPAN_HIGH],
		[CONFIG.REPO_SPAN_BASE_COUNT, "Long-span engagement", CONFIG.POINTS_REPO_SPAN_BASE],
	]);
	return flag ? [flag] : [];
}

export function detectDayOfWeekVariance(events: GitHubEvent[]): IdentifyFlag[] {
	if (events.length < CONFIG.DOW_EVENTS_MIN) return [];
	const counts = [0, 0, 0, 0, 0, 0, 0];
	for (const e of events) {
		if (!e.created_at) continue;
		counts[dayjs.utc(e.created_at).day()]++;
	}
	const mean = counts.reduce((a, b) => a + b, 0) / 7;
	if (mean === 0) return [];
	const variance = counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / 7;
	const cv = Math.sqrt(variance) / mean;
	if (cv < CONFIG.DOW_VARIANCE_CV_MIN) return [];
	return [{
		label: "Natural activity rhythm",
		points: CONFIG.POINTS_DOW_VARIANCE,
		detail: `Day-of-week variance CV ${cv.toFixed(2)} (≥${CONFIG.DOW_VARIANCE_CV_MIN} signals human rest pattern)`,
	}];
}

export function detectPreAiHistory(
	repos: Array<{ created_at: string }>,
): IdentifyFlag[] {
	const cutoff = `${CONFIG.PRE_AI_REPOS_YEAR}-01-01`;
	const count = repos.filter((r) => r.created_at < cutoff).length;
	const flag = tieredFlag(count, `${count} repositories created before ${CONFIG.PRE_AI_REPOS_YEAR}`, [
		[CONFIG.PRE_AI_REPOS_HIGH, "Pre-AI development history", CONFIG.POINTS_PRE_AI_REPOS_HIGH],
		[CONFIG.PRE_AI_REPOS_MIN, "Pre-AI development history", CONFIG.POINTS_PRE_AI_REPOS],
	]);
	return flag ? [flag] : [];
}

export function detectFollowerCount(
	profile: IdentifyProfile | undefined,
): IdentifyFlag[] {
	if (!profile) return [];
	const flag = tieredFlag(profile.followers, `${profile.followers} followers`, [
		[CONFIG.FOLLOWERS_HIGH, "Established following", CONFIG.POINTS_FOLLOWERS_HIGH],
		[CONFIG.FOLLOWERS_BASE, "Has followers", CONFIG.POINTS_FOLLOWERS_BASE],
	], { eventBased: false });
	return flag ? [flag] : [];
}

export function detectIdentityCompleteness(
	profile: IdentifyProfile | undefined,
): IdentifyFlag[] {
	if (!profile) return [];
	const fieldCount = [
		profile.name, profile.company, profile.location, profile.blog,
		profile.bio && profile.bio.length >= CONFIG.IDENTITY_BIO_MIN_LENGTH,
	].filter(Boolean).length;
	const flag = tieredFlag(fieldCount, `${fieldCount} profile fields filled`, [
		[CONFIG.IDENTITY_FIELDS_ALL, "Complete profile", CONFIG.POINTS_IDENTITY_HIGH],
		[CONFIG.IDENTITY_FIELDS_BASE, "Partial profile", CONFIG.POINTS_IDENTITY_BASE],
	], { eventBased: false });
	return flag ? [flag] : [];
}

// credits accounts with a track record of merged external PRs across many repos — real contributors shouldn't be penalized for being prolific
export function detectEstablishedContributorExemption(
	events: GitHubEvent[],
	accountName: string,
): IdentifyFlag[] {
	const mergedPRRepos = new Set<string>();
	for (const e of events) {
		if (e.type !== "PullRequestEvent") continue;
		const action = e.payload?.action;
		const isMerged = action === "merged" || (action === "closed" && e.payload?.pull_request?.merged === true);
		if (!isMerged) continue;
		if (isExternalEvent(e, accountName) && e.repo?.name) mergedPRRepos.add(e.repo.name);
	}
	if (mergedPRRepos.size < CONFIG.MERGED_PR_REPOS_HIGH) return [];
	const repoSpans = new Map<string, { first: number; last: number }>();
	for (const e of events) {
		if (!e.repo?.name || !e.created_at || !isExternalEvent(e, accountName)) continue;
		const ts = dayjs.utc(e.created_at).valueOf();
		const existing = repoSpans.get(e.repo.name);
		if (!existing) {
			repoSpans.set(e.repo.name, { first: ts, last: ts });
		} else {
			if (ts < existing.first) existing.first = ts;
			if (ts > existing.last) existing.last = ts;
		}
	}
	let longSpanCount = 0;
	for (const { first, last } of repoSpans.values()) {
		if (msToDays(last - first) >= CONFIG.REPO_SPAN_MIN_DAYS) longSpanCount++;
	}
	if (longSpanCount < CONFIG.REPO_SPAN_HIGH_COUNT) return [];
	return [{
		label: "Established contributor exemption",
		points: CONFIG.POINTS_ESTABLISHED_CONTRIBUTOR_EXEMPTION,
		detail: `${mergedPRRepos.size} merged PRs and ${longSpanCount} long-span repos`,
	}];
}
