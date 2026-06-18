import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { CONFIG } from "../config";
import type { GitHubEvent, IdentifyFlag } from "../types";
import { msToDays } from "../utils";

dayjs.extend(utc);

export function detectAccountAge(accountAge: number): IdentifyFlag[] {
	if (accountAge < CONFIG.AGE_NEW_ACCOUNT) {
		return [{ label: "Recently created", points: CONFIG.POINTS_NEW_ACCOUNT, detail: `Account is ${accountAge} days old`, eventBased: false }];
	}
	if (accountAge < CONFIG.AGE_YOUNG_ACCOUNT) {
		return [{ label: "Young account", points: CONFIG.POINTS_YOUNG_ACCOUNT, detail: `Account is ${accountAge} days old`, eventBased: false }];
	}
	return [];
}

// new accounts that already show uneven timing — skipped days, a gap where they stepped away — get some grace; bots don't take vacations or have slow Mondays
export function detectYoungAccountGrace(
	accountAge: number,
	events: GitHubEvent[],
): IdentifyFlag[] {
	if (accountAge >= CONFIG.AGE_YOUNG_ACCOUNT) return [];
	if (events.length < CONFIG.DOW_EVENTS_MIN) return [];
	const hasDayOfWeekVariance = () => {
		const counts = [0, 0, 0, 0, 0, 0, 0];
		for (const e of events) {
			if (!e.created_at) continue;
			counts[dayjs.utc(e.created_at).day()]++;
		}
		const mean = counts.reduce((a, b) => a + b, 0) / 7;
		if (mean === 0) return false;
		const variance = counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / 7;
		const cv = Math.sqrt(variance) / mean;
		return cv >= CONFIG.DOW_VARIANCE_CV_MIN;
	};
	const hasDormancyGap = () => {
		const timestamps = events
			.map((e) => e.created_at)
			.filter((t): t is string => !!t)
			.map((t) => dayjs.utc(t).valueOf())
			.sort((a, b) => a - b);
		if (timestamps.length < 2) return false;
		for (let i = 1; i < timestamps.length; i++) {
			if (msToDays(timestamps[i] - timestamps[i - 1]) >= CONFIG.DORMANCY_GAP_DAYS) return true;
		}
		return false;
	};
	const dow = hasDayOfWeekVariance();
	const gap = hasDormancyGap();
	if (dow && gap) {
		return [{ label: "Young account with organic timing", points: CONFIG.POINTS_YOUNG_ACCOUNT_GRACE_BOTH, detail: "Day-of-week variance and dormancy gap detected" }];
	}
	if (dow || gap) {
		return [{ label: "Young account with organic timing", points: CONFIG.POINTS_YOUNG_ACCOUNT_GRACE_ONE, detail: `${dow ? "Day-of-week variance" : "Dormancy gap"} detected` }];
	}
	return [];
}

export function detectAccountSeniority(accountAge: number): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];
	if (accountAge >= CONFIG.AGE_SENIOR_ACCOUNT) {
		flags.push({ label: "Established account", points: CONFIG.POINTS_SENIOR_ACCOUNT, detail: `Account is ${accountAge} days old (3+ years)`, eventBased: false });
	}
	if (accountAge >= CONFIG.AGE_VETERAN_ACCOUNT) {
		flags.push({ label: "Long-standing account", points: CONFIG.POINTS_VETERAN_ACCOUNT, detail: `Account is ${accountAge} days old (5+ years)`, eventBased: false });
	}
	return flags;
}
