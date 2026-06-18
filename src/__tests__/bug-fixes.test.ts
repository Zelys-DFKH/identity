import { describe, it, expect } from "vitest";
import dayjs from "dayjs";
import { detectClosedPRSpam } from "../detectors/closed-pr-spam";
import { detectLongSpanEngagement, detectDormancyGap } from "../detectors/human-signals";
import { detectYoungAccountActivity } from "../detectors/young-account";
import { detectYoungAccountGrace } from "../detectors/account-age";
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

describe("Feature: detectYoungAccountGrace", () => {
	it("should return -12 points when both day-of-week variance and dormancy gap are present", () => {
		const now = dayjs().utc();
		const events: GitHubEvent[] = [];
		for (let i = 0; i < 10; i++) {
			const dayOfWeek = i % 7;
			events.push({
				type: "PushEvent",
				repo: { name: "someoneelse/repo" },
				created_at: now.subtract(70 - i * 2, "day").add(dayOfWeek, "day").toISOString(),
			});
		}
		for (let i = 10; i < 20; i++) {
			const dayOfWeek = i % 7;
			events.push({
				type: "PushEvent",
				repo: { name: "someoneelse/repo" },
				created_at: now.subtract(10 - (i - 10) * 2, "day").add(dayOfWeek, "day").toISOString(),
			});
		}
		const flags = detectYoungAccountGrace(45, events);
		expect(flags.length).toBe(1);
		expect(flags[0].label).toBe("Young account with organic timing");
		expect(flags[0].points).toBe(-12);
	});

	it("should return -6 points when only day-of-week variance is present", () => {
		const now = dayjs().utc();
		const events: GitHubEvent[] = [];
		for (let i = 0; i < 20; i++) {
			const dayOfWeek = i % 7;
			events.push({
				type: "PushEvent",
				repo: { name: "someoneelse/repo" },
				created_at: now.subtract(25 - i, "day").add(dayOfWeek * 2, "hour").toISOString(),
			});
		}
		const flags = detectYoungAccountGrace(45, events);
		expect(flags.length).toBe(1);
		expect(flags[0].label).toBe("Young account with organic timing");
		expect(flags[0].points).toBe(-6);
	});

	it("should return empty array when account is not young", () => {
		const now = dayjs().utc();
		const events: GitHubEvent[] = [];
		for (let i = 0; i < 20; i++) {
			events.push({
				type: "PushEvent",
				repo: { name: "someoneelse/repo" },
				created_at: now.subtract(20 - i, "day").toISOString(),
			});
		}
		const flags = detectYoungAccountGrace(91, events);
		expect(flags).toEqual([]);
	});
});

import { detectEstablishedContributorExemption } from "../detectors/human-signals";
import { detectPushEventDiversity, detectInteractionDominance } from "../detectors/event-diversity";
import { detectImpossibleThroughput } from "../detectors/throughput-ceiling";
import { detectCircadianAbsence, detectCircadianPresence } from "../detectors/circadian";

describe("Feature: detectEstablishedContributorExemption", () => {
	it("returns exemption flag when merged PRs and long-span repos both qualify", () => {
		const now = dayjs().utc();
		const old = now.subtract(200, "day");
		const events: GitHubEvent[] = [];
		for (let i = 0; i < 8; i++) {
			events.push({ type: "PullRequestEvent", payload: { action: "closed", pull_request: { merged: true } }, repo: { name: `org${i}/repo` }, created_at: old.toISOString() });
			events.push({ type: "PushEvent", repo: { name: `org${i}/repo` }, created_at: old.toISOString() });
			events.push({ type: "PushEvent", repo: { name: `org${i}/repo` }, created_at: now.toISOString() });
		}
		const flags = detectEstablishedContributorExemption(events, "myaccount");
		expect(flags.length).toBe(1);
		expect(flags[0].label).toBe("Established contributor exemption");
		expect(flags[0].points).toBeLessThan(0);
	});

	it("returns [] when only merged PRs qualify but long-span repos do not", () => {
		const now = dayjs().utc();
		const events: GitHubEvent[] = [];
		for (let i = 0; i < 8; i++) {
			events.push({ type: "PullRequestEvent", payload: { action: "closed", pull_request: { merged: true } }, repo: { name: `org${i}/repo` }, created_at: now.toISOString() });
		}
		const flags = detectEstablishedContributorExemption(events, "myaccount");
		expect(flags).toEqual([]);
	});
});

describe("Feature: detectPushEventDiversity", () => {
	it("returns flag when pushes span 5+ distinct external owners", () => {
		const ts = new Date().toISOString();
		const events: GitHubEvent[] = [
			{ type: "PushEvent", repo: { name: "orgA/repo" }, created_at: ts },
			{ type: "PushEvent", repo: { name: "orgB/repo" }, created_at: ts },
			{ type: "PushEvent", repo: { name: "orgC/repo" }, created_at: ts },
			{ type: "PushEvent", repo: { name: "orgD/repo" }, created_at: ts },
			{ type: "PushEvent", repo: { name: "orgE/repo" }, created_at: ts },
		];
		const flags = detectPushEventDiversity(events, "myaccount");
		expect(flags.length).toBe(1);
		expect(flags[0].points).toBeLessThan(0);
	});

	it("returns [] when pushes span fewer than 5 external owners", () => {
		const ts = new Date().toISOString();
		const events: GitHubEvent[] = [
			{ type: "PushEvent", repo: { name: "orgA/repo" }, created_at: ts },
			{ type: "PushEvent", repo: { name: "orgB/repo" }, created_at: ts },
		];
		const flags = detectPushEventDiversity(events, "myaccount");
		expect(flags).toEqual([]);
	});
});

describe("Feature: detectInteractionDominance", () => {
	it("returns flag when 60%+ of 20+ events are interactions across 2+ repos", () => {
		const ts = new Date().toISOString();
		const events: GitHubEvent[] = [];
		for (let i = 0; i < 14; i++) events.push({ type: "IssueCommentEvent", repo: { name: i % 2 === 0 ? "org/repoA" : "org/repoB" }, created_at: ts });
		for (let i = 0; i < 6; i++) events.push({ type: "PushEvent", created_at: ts });
		const flags = detectInteractionDominance(events);
		expect(flags.length).toBe(1);
		expect(flags[0].label).toBe("Interaction-focused contributor");
	});

	it("returns [] when fewer than 20 events", () => {
		const ts = new Date().toISOString();
		const events: GitHubEvent[] = Array.from({ length: 15 }, () => ({ type: "IssueCommentEvent", created_at: ts }));
		const flags = detectInteractionDominance(events);
		expect(flags).toEqual([]);
	});
});

describe("Feature: detectImpossibleThroughput", () => {
	it("flags 150 write events within 2-hour window", () => {
		const base = Date.now();
		const events: GitHubEvent[] = Array.from({ length: 150 }, (_, i) => ({
			type: "PushEvent",
			created_at: new Date(base + i * 10000).toISOString(),
		}));
		const flags = detectImpossibleThroughput(events);
		expect(flags.length).toBe(1);
		expect(flags[0].label).toBe("Impossible throughput");
	});

	it("does not flag 149 write events", () => {
		const base = Date.now();
		const events: GitHubEvent[] = Array.from({ length: 149 }, (_, i) => ({
			type: "PushEvent",
			created_at: new Date(base + i * 10000).toISOString(),
		}));
		const flags = detectImpossibleThroughput(events);
		expect(flags).toEqual([]);
	});
});

describe("Feature: detectCircadianAbsence", () => {
	it("flags account active across all 24 hours with no quiet window", () => {
		const events: GitHubEvent[] = [];
		const base = new Date("2024-01-01T00:00:00Z").getTime();
		for (let h = 0; h < 24; h++) {
			for (let j = 0; j < 3; j++) {
				events.push({ type: "PushEvent", created_at: new Date(base + h * 3600000 + j * 1000).toISOString() });
			}
		}
		const flags = detectCircadianAbsence(events);
		expect(flags.length).toBe(1);
		expect(flags[0].label).toBe("No circadian rest pattern");
	});

	it("does not flag account with 4+ quiet hours (e.g. only active 08-22 UTC)", () => {
		const events: GitHubEvent[] = [];
		const base = new Date("2024-01-01T00:00:00Z").getTime();
		for (let h = 8; h < 22; h++) {
			for (let j = 0; j < 4; j++) {
				events.push({ type: "PushEvent", created_at: new Date(base + h * 3600000 + j * 1000).toISOString() });
			}
		}
		const flags = detectCircadianAbsence(events);
		expect(flags).toEqual([]);
	});
});

describe("Feature: detectCircadianPresence", () => {
	it("returns positive flag when account is active 08-22 UTC across 7+ days", () => {
		const events: GitHubEvent[] = [];
		for (let day = 0; day < 10; day++) {
			const dayBase = new Date(2024, 0, 1 + day, 0, 0, 0, 0).getTime();
			for (let h = 8; h < 22; h++) {
				for (let j = 0; j < 4; j++) {
					events.push({ type: "PushEvent", created_at: new Date(dayBase + h * 3600000 + j * 1000).toISOString() });
				}
			}
		}
		const flags = detectCircadianPresence(events);
		expect(flags.length).toBe(1);
		expect(flags[0].label).toBe("Diurnal activity pattern");
		expect(flags[0].points).toBeLessThan(0);
	});

	it("returns [] when fewer than CIRCADIAN_MIN_EVENTS events", () => {
		const events: GitHubEvent[] = Array.from({ length: 10 }, (_, i) => ({
			type: "PushEvent",
			created_at: new Date(Date.now() + i * 1000).toISOString(),
		}));
		const flags = detectCircadianPresence(events);
		expect(flags).toEqual([]);
	});
});
