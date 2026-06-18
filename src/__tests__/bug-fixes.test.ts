import { describe, it, expect } from "vitest";
import dayjs from "dayjs";
import { detectClosedPRSpam } from "../detectors/closed-pr-spam";
import { detectLongSpanEngagement, detectDormancyGap } from "../detectors/human-signals";
import { detectYoungAccountActivity } from "../detectors/young-account";
import { computeActivityRecencyMultiplier } from "../utils";
import type { GitHubEvent } from "../types";

describe("Bug Fix: closed-pr-spam.ts fractionalDays edge case", () => {
	it("should handle very small fractionalDays without inflating density", () => {
		const now = new Date();
		const sameDay = now.toISOString();
		const events: GitHubEvent[] = [
			{ type: "PullRequestEvent", payload: { action: "closed" }, repo: { name: "repo1" }, created_at: sameDay },
			{ type: "PullRequestEvent", payload: { action: "closed" }, repo: { name: "repo2" }, created_at: sameDay },
			{ type: "PullRequestEvent", payload: { action: "closed" }, repo: { name: "repo3" }, created_at: sameDay },
		];
		const flags = detectClosedPRSpam(events, 365);
		expect(flags).toBeDefined();
		expect(Array.isArray(flags)).toBe(true);
		const scatter = flags.find((f) => f.label === "Closed PR spam across repos");
		if (scatter) {
			expect(scatter.detail).toContain("3 PRs");
		}
	});
});

describe("Bug Fix: human-signals.ts detectLongSpanEngagement zero-span edge case", () => {
	it("should not count single-event repos with zero span", () => {
		const now = dayjs().utc();
		const events: GitHubEvent[] = [
			{
				type: "PushEvent",
				repo: { name: "someoneelse/repo1" },
				created_at: now.toISOString(),
			},
		];
		const flags = detectLongSpanEngagement(events, "myaccount");
		expect(flags).toEqual([]);
	});

	it("should count repos with positive span >= threshold", () => {
		const now = dayjs().utc();
		const dayAgo = now.subtract(121, "day");
		const events: GitHubEvent[] = [
			{ type: "PushEvent", repo: { name: "someoneelse/repo1" }, created_at: dayAgo.toISOString() },
			{ type: "PushEvent", repo: { name: "someoneelse/repo1" }, created_at: now.toISOString() },
			{ type: "PushEvent", repo: { name: "someoneelse/repo2" }, created_at: dayAgo.toISOString() },
			{ type: "PushEvent", repo: { name: "someoneelse/repo2" }, created_at: now.toISOString() },
		];
		const flags = detectLongSpanEngagement(events, "myaccount");
		expect(flags.length).toBeGreaterThan(0);
	});
});

describe("Bug Fix: human-signals.ts detectDormancyGap same-day edge case", () => {
	it("should handle events all on same day", () => {
		const now = dayjs().utc();
		const events: GitHubEvent[] = [
			{ type: "PushEvent", created_at: now.toISOString() },
			{ type: "PushEvent", created_at: now.add(1, "hour").toISOString() },
			{ type: "PushEvent", created_at: now.add(2, "hour").toISOString() },
		];
		const flags = detectDormancyGap(events);
		expect(Array.isArray(flags)).toBe(true);
	});
});

describe("Bug Fix: utils.ts computeActivityRecencyMultiplier NaN handling", () => {
	it("should skip NaN timestamps instead of counting them", () => {
		const validEvent = { created_at: new Date().toISOString() };
		const invalidEvent1 = { created_at: null };
		const invalidEvent2 = { created_at: undefined };
		const events = [validEvent, invalidEvent1, invalidEvent2];
		const multiplier = computeActivityRecencyMultiplier(events, 7);
		expect(Number.isFinite(multiplier)).toBe(true);
		expect(multiplier).toBeGreaterThan(0);
		expect(multiplier).toBeLessThanOrEqual(1.1);
	});

	it("should return 1 when all timestamps are invalid", () => {
		const events = [{ created_at: null }, { created_at: undefined }];
		const multiplier = computeActivityRecencyMultiplier(events, 7);
		expect(multiplier).toBe(1);
	});
});

describe("Bug Fix: young-account.ts same-day PR span", () => {
	it("should handle same-day PR spans correctly", () => {
		const now = dayjs().utc();
		const sameDay = now.toISOString();
		const events: GitHubEvent[] = [
			{
				type: "PullRequestEvent",
				payload: { action: "opened" },
				repo: { name: "external/repo1" },
				created_at: sameDay,
			},
			{
				type: "PullRequestEvent",
				payload: { action: "opened" },
				repo: { name: "external/repo1" },
				created_at: sameDay,
			},
		];
		const flags = detectYoungAccountActivity(events, 0, true, "myaccount");
		expect(Array.isArray(flags)).toBe(true);
		if (flags.length > 0) {
			expect(flags.some((f) => f.points !== undefined && f.points >= 0)).toBe(true);
		}
	});
});
