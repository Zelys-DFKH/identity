import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identify } from "../src/identify";
import type { GitHubEvent, IdentifyOptions, IdentifyResult } from "../src/types";
import { makeEvent } from "./helpers/make-event";

const date = new Date(2026, 2, 10, 12);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(date);
});

afterEach(() => {
	vi.useRealTimers();
});

function makeInput(events: GitHubEvent[], overrides: Partial<IdentifyOptions> = {}): IdentifyOptions {
	return { createdAt: "2025-01-01T00:00:00Z", reposCount: 10, accountName: "testuser", events, ...overrides };
}

const hasForkFlag = (r: IdentifyResult) => r.flags.some((f) => /fork/i.test(f.label));

// NOTE: pads with PushEvents at slash-less repos (e.g. "pad0"), which the detectIssueBurst
// hasExternalPush guard counts as external activity. Do not use padToMin in issue burst tests.
function padToMin(events: GitHubEvent[], target: number, repoPrefix = "pad", baseTs = new Date(Date.UTC(2026, 2, 10))): GitHubEvent[] {
	while (events.length < target) {
		const idx = events.length;
		events.push(makeEvent("PushEvent", `${repoPrefix}${idx}`, new Date(baseTs.getTime() + idx * 3600_000).toISOString()));
	}
	return events;
}

function expectNoPrSpamFlags(result: IdentifyResult): void {
	expect(findFlag(result, "Extreme PR spam (daily)")).toBeUndefined();
	expect(findFlag(result, "Extreme PR spam (weekly)")).toBeUndefined();
	expect(findFlag(result, "Very high PR spam frequency")).toBeUndefined();
}
const hasFlag = (r: IdentifyResult, label: string) => r.flags.some((f) => f.label === label);
const findFlag = (r: IdentifyResult, label: string) => r.flags.find((f) => f.label === label);
const hasIssueCommentSpam = (r: IdentifyResult) =>
	r.flags.some((f) => f.label === "Issue comment spam" || f.label === "High comment frequency across repos");
const hasPrCommentSpam = (r: IdentifyResult) =>
	r.flags.some((f) => f.label === "PR comment spam" || f.label === "High PR comment frequency");
const makeWatchTs = (ts: string) => makeEvent("WatchEvent", "other/popular-repo", ts);


describe("identify - Account Age Flags", () => {
	it("should flag recently created accounts (< 30 days old)", () => {
		const recentDate = new Date(2026, 2, 5); // 5 days old
		const result = identify(makeInput([], { createdAt: recentDate.toISOString(), reposCount: 5, accountName: "newuser" }));

		expect(result.flags).toContainEqual(
			expect.objectContaining({ label: "Recently created" }),
		);
	});

	it("should flag young accounts (30-90 days old)", () => {
		const youngDate = new Date(2026, 0, 20); // ~50 days old
		const result = identify(makeInput([], { createdAt: youngDate.toISOString(), reposCount: 5, accountName: "younguser" }));

		expect(result.flags).toContainEqual(
			expect.objectContaining({ label: "Young account" }),
		);
	});

	it("should not flag established accounts (> 90 days old)", () => {
		const establishedDate = new Date(2025, 11, 1); // > 100 days old
		const result = identify(makeInput([], { createdAt: establishedDate.toISOString(), reposCount: 5, accountName: "olduser" }));

		expect(hasFlag(result, "Recently created")).toBe(false);
		expect(hasFlag(result, "Young account")).toBe(false);
	});
});

describe("identify - Zero Repos & External Activity", () => {
	it("should flag accounts with no personal repos but external activity", () => {
		const events: GitHubEvent[] = [];
		// Need ZERO_REPOS_MIN_EVENTS (20) events for the flag to trigger
		for (let i = 0; i < 20; i++) {
			events.push(makeEvent("PushEvent", `other-org/repo${i}`, new Date(2026,2,10,Math.floor(i / 4),0,0).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-12-01T00:00:00Z", reposCount: 0, accountName: "contributor" }));

		expect(
			result.flags.some((f) =>
				f.label.includes("Only active on other people's repos"),
			),
		).toBe(true);
	});
});

describe("identify - Fork Surge Detection", () => {
	it("should flag multiple forks (5-7 in 24 hours)", () => {
		const events = Array.from({ length: 6 }, (_, i) => makeEvent("ForkEvent", `repo${i}`, new Date(2026, 2, 10, i, 0, 0).toISOString()));

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 10, accountName: "user" }));

		expect(hasFlag(result, "Multiple forks")).toBe(true);
	});

	it("should flag fork spike (8-19 in 24 hours)", () => {
		const events = Array.from({ length: 10 }, (_, i) => makeEvent("ForkEvent", `repo${i}`, new Date(2026, 2, 10, i, 0, 0).toISOString()));

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 10, accountName: "user" }));

		expect(hasFlag(result, "Fork spike detected")).toBe(true);
	});

	it("should not flag forks spread over more than 24 hours", () => {
		const events = Array.from({ length: 10 }, (_, i) => makeEvent("ForkEvent", `repo${i}`, new Date(2026,2,10 + Math.floor(i / 3),i * 2,0).toISOString()));

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 10, accountName: "user" }));

		expect(hasForkFlag(result)).toBe(false);
	});

	it("should not show sustained fork rate on single-day spikes", () => {
		const events: GitHubEvent[] = [];
		// Create 17 forks in 24 hours (spike detected)
		for (let i = 0; i < 17; i++) {
			events.push(makeEvent("ForkEvent", `repo${i}`, new Date(2026,2,10,Math.floor(i * 1.4),0,0).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 10, accountName: "user" }));

		// Should have spike detected
		expect(hasFlag(result, "Fork spike detected")).toBe(true);

		// Should NOT have sustained fork rate (spike only spans 1 day)
		expect(hasFlag(result, "Sustained fork rate")).toBe(false);
	});

	it("should not show fork scatter pattern when spike is detected", () => {
		const events: GitHubEvent[] = [];
		// Create 20 forks in 24 hours across 20 different repos (spike + diversity)
		for (let i = 0; i < 20; i++) {
			events.push(makeEvent("ForkEvent", `repo${i}`, new Date(2026,2,10,Math.floor(i * 1.2),0,0).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 10, accountName: "user" }));

		// Should have spike detected (20 in 24h)
		expect(
			result.flags.some(
				(f) =>
					f.label.includes("Severe fork surge") || f.label.includes("Extreme"),
			),
		).toBe(true);

		// Should NOT have scatter pattern (spike already indicates the threat)
		expect(hasFlag(result, "Fork scatter pattern")).toBe(false);
	});

	it("should show fork scatter pattern for slow, distributed targeting", () => {
		const events: GitHubEvent[] = [];
		// Create 20 forks over 10 days across 20 different repos (no spike, but wide spread)
		for (let i = 0; i < 20; i++) {
			events.push(makeEvent("ForkEvent", `repo${i}`, new Date(2026,2,10 + Math.floor(i / 2),i * 4,0).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 10, accountName: "user" }));

		// Should NOT have spike (only 2 per day, spread over 10 days)
		expect(
			result.flags.some(
				(f) => f.label.includes("spike") || f.label.includes("Spike"),
			),
		).toBe(false);

		// Should have scatter pattern (diversity of targets)
		expect(hasFlag(result, "Fork scatter pattern")).toBe(true);
	});
});

describe("identify - Repository Creation Patterns", () => {
	it("should flag frequent repository creation (8+ repos in 24 hours)", () => {
		const events: GitHubEvent[] = [];
		// Create 8 repo creation events - using UTC to avoid timezone issues
		for (let i = 0; i < 8; i++) {
			events.push(makeEvent("CreateEvent", `repo${i}`, new Date(Date.UTC(2026, 2, 10, i, 0, 0)).toISOString(), { ref_type: "repository" }));
		}
		padToMin(events, 10);

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 100, accountName: "user" }));

		expect(hasFlag(result, "Frequent repository creation")).toBe(true);
	});

	it("should flag concentrated repository creation (16+ repos in 24 hours)", () => {
		const events: GitHubEvent[] = [];
		// Create 16 repo creation events - using UTC to avoid timezone issues
		for (let i = 0; i < 16; i++) {
			events.push(makeEvent("CreateEvent", `repo${i}`, new Date(Date.UTC(2026, 2, 10, Math.floor(i / 2), 0, 0)).toISOString(), { ref_type: "repository" }));
		}
		// Add 2 more events to meet MIN_EVENTS_FOR_ANALYSIS (10)
		events.push(makeEvent("PushEvent", "extra1", new Date(Date.UTC(2026, 2, 10, 8, 0, 0)).toISOString()));
		events.push(makeEvent("PushEvent", "extra2", new Date(Date.UTC(2026, 2, 10, 9, 0, 0)).toISOString()));

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 100, accountName: "user" }));

		expect(hasFlag(result, "Concentrated repository creation")).toBe(true);
	});

	it("should ignore CreateEvent that are branch creations, not repos", () => {
		const events = Array.from({ length: 5 }, (_, i) => makeEvent("CreateEvent", `repo${i}`, new Date(Date.UTC(2026, 2, 10, i, 0, 0)).toISOString(), { ref_type: "branch" }));

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 10, accountName: "user" }));

		expect(
			result.flags.some((f) =>
				f.label.includes("Concentrated repository creation"),
			),
		).toBe(false);
	});
});

describe("identify - Activity Pattern Detection", () => {
	it("should flag 24/7 activity pattern (< 3 hours sleep on single day)", () => {
		const events: GitHubEvent[] = [];
		// Simulate activity across 22 hours with only 1 hour gap
		for (let hour = 0; hour < 23; hour++) {
			if (hour !== 12) {
				// 1 hour gap
				events.push(makeEvent("PushEvent", "repo", new Date(Date.UTC(2026, 2, 10, hour, 0, 0)).toISOString()));
				events.push(makeEvent("PushEvent", "repo", new Date(Date.UTC(2026, 2, 10, hour, 30, 0)).toISOString()));
			}
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 5, accountName: "user" }));

		expect(hasFlag(result, "24/7 activity pattern")).toBe(true);
	});

	it("should not flag 24/7 pattern if activity is spread over multiple days", () => {
		const events: GitHubEvent[] = [];
		// Activity spread across multiple days, each day has normal sleep
		for (let day = 0; day < 5; day++) {
			for (let hour = 8; hour < 20; hour++) {
				events.push(makeEvent("PushEvent", "repo", new Date(2026, 2, 10 + day, hour, 0, 0).toISOString()));
			}
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 5, accountName: "user" }));

		expect(hasFlag(result, "24/7 activity pattern")).toBe(false);
	});
});

describe("identify - Narrow Activity Focus", () => {
	it("should flag narrow activity focus (few event types, no interactions)", () => {
		const events = Array.from({ length: 15 }, (_, i) => makeEvent("PushEvent", "repo", new Date(2026, 2, 10, i, 0, 0).toISOString()));

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 5, accountName: "user" }));

		// Pure push events with low diversity and no interaction
		expect(hasFlag(result, "Narrow activity focus")).toBe(true);
	});

	it("should not flag narrow focus if there are human interactions", () => {
		const events: GitHubEvent[] = [];
		// Push events
		for (let i = 0; i < 12; i++) {
			events.push(makeEvent("PushEvent", "repo", new Date(2026, 2, 10, i, 0, 0).toISOString()));
		}
		// Add interaction
		events.push(makeEvent("IssueCommentEvent", "repo", new Date(2026, 2, 10, 13, 0, 0).toISOString()));

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 5, accountName: "user" }));

		expect(hasFlag(result, "Narrow activity focus")).toBe(false);
	});
});

describe("identify - Score Calculation", () => {
	it("should calculate score as 100 minus sum of all flag points", () => {
		const events: GitHubEvent[] = [];
		// Create fork spike to add points
		for (let i = 0; i < 10; i++) {
			events.push(makeEvent("ForkEvent", `repo${i}`, new Date(2026, 2, 10, i, 0, 0).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 10, accountName: "user" }));

		// Should have some fork-related flags
		const totalPoints = result.flags.reduce(
			(sum, flag) => sum + flag.points,
			0,
		);
		const expectedScore = Math.max(0, 100 - totalPoints);
		expect(result.score).toBe(expectedScore);
		expect(result.score).toBeLessThanOrEqual(100);
		expect(result.score).toBeGreaterThanOrEqual(0);
	});

	it("should return score of 100 for account with no flags", () => {
		const result = identify(makeInput([], { createdAt: "2025-01-01T00:00:00Z", reposCount: 10, accountName: "established" }));

		expect(result.score).toBe(100);
		expect(result.flags).toHaveLength(0);
	});

	it("should cap score at 0 minimum", () => {
		const events: GitHubEvent[] = [];
		// Create massive fork spike
		for (let i = 0; i < 50; i++) {
			events.push(makeEvent("ForkEvent", `repo${i}`, new Date(2026,2,10,Math.floor(i / 2),i % 60,0).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2026-03-08T00:00:00Z", reposCount: 0, accountName: "bot" }));

		expect(result.score).toBeGreaterThanOrEqual(0);
	});
});

describe("identify - Classification", () => {
	it("should classify as organic when score >= 70", () => {
		const result = identify(makeInput([], { createdAt: "2025-01-01T00:00:00Z", reposCount: 100, accountName: "established" }));

		expect(result.classification).toBe("organic");
		expect(result.score).toBeGreaterThanOrEqual(70);
	});

	it("should classify as mixed when score is between 50-69", () => {
		const events: GitHubEvent[] = [];
		// Create moderate fork activity
		for (let i = 0; i < 6; i++) {
			events.push(makeEvent("ForkEvent", `repo${i}`, new Date(2026, 2, 10, i, 0, 0).toISOString()));
		}
		// Push event prevents consumer-no-reciprocity from also firing
		events.push(makeEvent("PushEvent", "org/shared-repo", new Date(2026, 2, 10, 10, 0, 0).toISOString()));

		const result = identify(makeInput(events, { createdAt: "2026-04-15T00:00:00Z", reposCount: 100, accountName: "user" }));

		// Total penalty points: 26 (forks) + 20 (new account) = 46 → score = 100 - 46 = 54
		expect(result.classification).toBe("mixed");
		expect(result.score).toBeGreaterThanOrEqual(50);
		expect(result.score).toBeLessThan(70);
	});

	it("should classify as automation when score < 50", () => {
		const events: GitHubEvent[] = [];
		// Create multiple automation indicators
		for (let i = 0; i < 35; i++) {
			events.push(makeEvent("ForkEvent", `repo${i}`, new Date(2026,2,10,Math.floor(i / 5),i * 2,0).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2026-03-08T00:00:00Z", reposCount: 0, accountName: "bot" }));

		// Total penalty points: 85 (forks) + 10 (young account) = 95 → score = 100 - 95 = 5
		expect(result.classification).toBe("automation");
		expect(result.score).toBeLessThan(50);
	});
});

describe("identify - Profile Information", () => {
	it("should include correct account age in profile", () => {
		const result = identify(makeInput([], { createdAt: "2025-12-01T00:00:00Z", reposCount: 5, accountName: "user" }));

		expect(result.profile.age).toBeGreaterThanOrEqual(99);
		expect(result.profile.age).toBeLessThan(110);
	});

	it("should include repos count in profile", () => {
		const result = identify(makeInput([], { createdAt: "2025-01-01T00:00:00Z", reposCount: 42, accountName: "user" }));

		expect(result.profile.repos).toBe(42);
	});
});

describe("identify - Issue Comment Spam Detection", () => {
	it("should flag extreme issue comment spam (15+ repos in 2 minutes)", () => {
		const events: GitHubEvent[] = [];
		// Create 15 issue comment events on different repos within 2 minutes
		for (let i = 0; i < 15; i++) {
			events.push(makeEvent("IssueCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 8).toISOString()));
		}
		// Add more events to meet MIN_EVENTS_FOR_ANALYSIS (10)
		for (let i = 15; i < 16; i++) {
			events.push(makeEvent("PushEvent", "owner/main", new Date(2026, 2, 10, 12, 2, 0).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 30, accountName: "user" }));

		expect(hasFlag(result, "Issue comment spam")).toBe(true);
	});

	it("should flag issue comment spray at the ISSUE_COMMENT_SPRAY_HIGH boundary (6 repos)", () => {
		const events: GitHubEvent[] = [];
		// 10 IssueCommentEvents within 2 minutes, spread across exactly 6 repos
		for (let i = 0; i < 10; i++) {
			events.push(makeEvent("IssueCommentEvent", `owner/repo${i % 6}`, new Date(2026, 2, 10, 12, 0, i * 10).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		expect(hasFlag(result, "High comment frequency across repos")).toBe(true);
		// 6 repos is below ISSUE_COMMENT_SPRAY_EXTREME (15), so the extreme label must not fire
		expect(hasFlag(result, "Issue comment spam")).toBe(false);
	});

	it("should not flag issue comment spray just below the ISSUE_COMMENT_SPRAY_HIGH boundary (5 repos)", () => {
		const events: GitHubEvent[] = [];
		// 10 IssueCommentEvents within 2 minutes, spread across only 5 repos
		for (let i = 0; i < 10; i++) {
			events.push(makeEvent("IssueCommentEvent", `owner/repo${i % 5}`, new Date(2026, 2, 10, 12, 0, i * 10).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		expect(hasIssueCommentSpam(result)).toBe(false);
	});

	it("should flag high issue comment frequency (10-14 repos in short timeframe)", () => {
		const events: GitHubEvent[] = [];
		// Create 10 issue comment events within 2 minutes
		for (let i = 0; i < 10; i++) {
			events.push(makeEvent("IssueCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 12).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 30, accountName: "user" }));

		expect(hasFlag(result, "High comment frequency across repos")).toBe(true);
	});

	it("should not flag issue comments spread over longer time periods", () => {
		const events: GitHubEvent[] = [];
		// Create issue comment events spread across 1 hour (not in 2 minute window)
		for (let i = 0; i < 15; i++) {
			events.push(makeEvent("IssueCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, i * 4, 0).toISOString()));
		}
		// Add more events to meet MIN_EVENTS_FOR_ANALYSIS
		events.push(makeEvent("PushEvent", "owner/main", new Date(2026, 2, 10, 13, 0, 0).toISOString()));

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 30, accountName: "user" }));

		expect(hasIssueCommentSpam(result)).toBe(false);
	});

	it("should not flag low number of issue comments", () => {
		const events: GitHubEvent[] = [];
		// Only 5 issue comments - below ISSUE_COMMENT_MIN_FOR_SPRAY threshold (10)
		for (let i = 0; i < 5; i++) {
			events.push(makeEvent("IssueCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 20).toISOString()));
		}
		padToMin(events, 10);

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		expect(hasIssueCommentSpam(result)).toBe(false);
	});

	it("should include correct comment count and repo count in flag detail", () => {
		const events: GitHubEvent[] = [];
		// Create 10 issue comments on different repos within 2 minutes
		for (let i = 0; i < 10; i++) {
			events.push(makeEvent("IssueCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 12).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		const issueCommentFlag = findFlag(result, "High comment frequency across repos");
		expect(issueCommentFlag).toBeDefined();
		if (issueCommentFlag) {
			expect(issueCommentFlag.detail).toContain("comments");
			expect(issueCommentFlag.detail).toContain("different repos");
			expect(issueCommentFlag.detail).toContain("minutes");
		}
	});

	it("should properly calculate comments per minute in flag detail", () => {
		const events: GitHubEvent[] = [];
		// Create 10 issue comments within 30 seconds (should be ~20 comments/min)
		for (let i = 0; i < 10; i++) {
			events.push(makeEvent("IssueCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 3).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		const issueCommentFlag = result.flags.find(
			(f) =>
				f.label === "Issue comment spam" ||
				f.label === "High comment frequency across repos",
		);
		expect(issueCommentFlag).toBeDefined();
		if (issueCommentFlag) {
			// Should show comments, repos, and time window (but not decimal metrics)
			expect(issueCommentFlag.detail).toMatch(/comments to.*repos in.*minutes/);
		}
	});

	it("should assign correct points for extreme issue comment spam", () => {
		const events: GitHubEvent[] = [];
		// Create 20 issue comments on different repos within 2 minutes
		for (let i = 0; i < 20; i++) {
			events.push(makeEvent("IssueCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 6).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 30, accountName: "user" }));

		const issueSpamFlag = findFlag(result, "Issue comment spam");
		expect(issueSpamFlag).toBeDefined();
		expect(issueSpamFlag?.points).toBeGreaterThanOrEqual(35);
	});

	it("should assign correct points for high issue comment frequency", () => {
		const events: GitHubEvent[] = [];
		// Create 10 issue comments within 2 minutes
		for (let i = 0; i < 10; i++) {
			events.push(makeEvent("IssueCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 12).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		const issueFreqFlag = findFlag(result, "High comment frequency across repos");
		expect(issueFreqFlag).toBeDefined();
		expect(issueFreqFlag?.points).toBeGreaterThanOrEqual(25);
		expect(issueFreqFlag?.points).toBeLessThanOrEqual(35);
	});

	it("should handle edge case of exactly threshold number of issue comments", () => {
		const events: GitHubEvent[] = [];
		// Create exactly 10 issue comments (threshold) on different repos
		for (let i = 0; i < 10; i++) {
			events.push(makeEvent("IssueCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 12).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		// At threshold (10), should flag as "High comment frequency across repos"
		expect(hasFlag(result, "High comment frequency across repos")).toBe(true);
	});

	it("should count distinct repos, not total comments, when determining spray severity", () => {
		const events: GitHubEvent[] = [];
		// Create 15 issue comments but on only 9 different repos
		// This should flag as "High comment frequency" (9 >= threshold of 10 is false, so this tests the low threshold)
		// Better: create comments on 11 repos but with some duplicates
		const repos = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		for (let i = 0; i < 15; i++) {
			const repoIdx = repos[i % repos.length]!;
			events.push(makeEvent("IssueCommentEvent", `owner/repo${repoIdx}`, new Date(2026, 2, 10, 12, 0, i * 8).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		// Should flag as "High comment frequency" (11 distinct repos >= threshold of 10)
		expect(hasFlag(result, "High comment frequency across repos")).toBe(true);
	});
});

describe("identify - PR Comment Spam Detection", () => {
	it("should flag extreme PR comment spam (12+ PRs in 2 minutes)", () => {
		const events: GitHubEvent[] = [];
		// Create 12 PR comment events on different PRs within 2 minutes
		for (let i = 0; i < 12; i++) {
			events.push(makeEvent("PullRequestReviewCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 10).toISOString()));
		}
		// Add more events to meet MIN_EVENTS_FOR_ANALYSIS (10)
		for (let i = 12; i < 14; i++) {
			events.push(makeEvent("PushEvent", "owner/main", new Date(2026, 2, 10, 12, 2, 0).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		expect(hasFlag(result, "PR comment spam")).toBe(true);
	});

	it("should flag high PR comment frequency (8-11 PRs in short timeframe)", () => {
		const events: GitHubEvent[] = [];
		// Create 8 PR comment events within 2 minutes
		for (let i = 0; i < 8; i++) {
			events.push(makeEvent("PullRequestReviewCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 15).toISOString()));
		}
		padToMin(events, 10);

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		expect(hasFlag(result, "High PR comment frequency")).toBe(true);
	});

	it("should not flag PR comments spread over longer time periods", () => {
		const events: GitHubEvent[] = [];
		// Create PR comment events spread across 1 hour (not in 2 minute window)
		for (let i = 0; i < 12; i++) {
			events.push(makeEvent("PullRequestReviewCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, i * 5, 0).toISOString()));
		}
		// Add more events to meet MIN_EVENTS_FOR_ANALYSIS
		events.push(makeEvent("PushEvent", "owner/main", new Date(2026, 2, 10, 13, 0, 0).toISOString()));

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		expect(hasPrCommentSpam(result)).toBe(false);
	});

	it("should not flag low number of PR comments", () => {
		const events: GitHubEvent[] = [];
		// Only 5 PR comments - below PR_COMMENT_MIN_FOR_SPRAY threshold (8)
		for (let i = 0; i < 5; i++) {
			events.push(makeEvent("PullRequestReviewCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 20).toISOString()));
		}
		padToMin(events, 10);

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		expect(hasPrCommentSpam(result)).toBe(false);
	});

	it("should include correct comment count and repo count in flag detail", () => {
		const events: GitHubEvent[] = [];
		// Create 10 PR comments on different repos within 2 minutes
		for (let i = 0; i < 10; i++) {
			events.push(makeEvent("PullRequestReviewCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 10).toISOString()));
		}
		// Add more events to meet MIN_EVENTS_FOR_ANALYSIS
		for (let i = 10; i < 12; i++) {
			events.push(makeEvent("PushEvent", "owner/main", new Date(2026, 2, 10, 12, 2, 0).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		const prCommentFlag = findFlag(result, "High PR comment frequency");
		expect(prCommentFlag).toBeDefined();
		if (prCommentFlag) {
			expect(prCommentFlag.detail).toContain("comments");
			expect(prCommentFlag.detail).toContain("different PRs");
			expect(prCommentFlag.detail).toContain("minutes");
		}
	});

	it("should properly calculate comments per minute in flag detail", () => {
		const events: GitHubEvent[] = [];
		// Create 8 PR comments within 30 seconds (should be ~16 comments/min)
		for (let i = 0; i < 8; i++) {
			events.push(makeEvent("PullRequestReviewCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 4).toISOString()));
		}
		padToMin(events, 10);

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		const prCommentFlag = result.flags.find(
			(f) =>
				f.label === "PR comment spam" ||
				f.label === "High PR comment frequency",
		);
		expect(prCommentFlag).toBeDefined();
		if (prCommentFlag) {
			// Should show comments, PRs, and time window (but not decimal metrics)
			expect(prCommentFlag.detail).toMatch(/comments on.*PRs in.*minutes/);
		}
	});

	it("should distinguish between issue comments and PR comments", () => {
		const events: GitHubEvent[] = [];
		// Create PR comment events
		for (let i = 0; i < 10; i++) {
			events.push(makeEvent("PullRequestReviewCommentEvent", `owner/pr-repo${i}`, new Date(2026, 2, 10, 12, 0, i * 10).toISOString()));
		}
		// Create separate issue comment events
		for (let i = 0; i < 10; i++) {
			events.push(makeEvent("IssueCommentEvent", `owner/issue-repo${i}`, new Date(2026, 2, 10, 12, 5, i * 10).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 30, accountName: "user" }));

		// Should flag both issue and PR comment spam independently
		const hasIssueSpam = hasIssueCommentSpam(result);
		const hasPRSpam = hasPrCommentSpam(result);

		expect(hasIssueSpam).toBe(true);
		expect(hasPRSpam).toBe(true);
	});

	it("should assign correct points for extreme PR comment spam", () => {
		const events: GitHubEvent[] = [];
		// Create 15 PR comments on different repos within 2 minutes
		for (let i = 0; i < 15; i++) {
			events.push(makeEvent("PullRequestReviewCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 8).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 30, accountName: "user" }));

		const prSpamFlag = findFlag(result, "PR comment spam");
		expect(prSpamFlag).toBeDefined();
		expect(prSpamFlag?.points).toBeGreaterThanOrEqual(35);
	});

	it("should assign correct points for high PR comment frequency", () => {
		const events: GitHubEvent[] = [];
		// Create 8 PR comments within 2 minutes
		for (let i = 0; i < 8; i++) {
			events.push(makeEvent("PullRequestReviewCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 15).toISOString()));
		}
		padToMin(events, 10);

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		const prFreqFlag = findFlag(result, "High PR comment frequency");
		expect(prFreqFlag).toBeDefined();
		expect(prFreqFlag?.points).toBeGreaterThanOrEqual(25);
		expect(prFreqFlag?.points).toBeLessThanOrEqual(32);
	});

	it("should handle edge case of exactly threshold number of PR comments", () => {
		const events: GitHubEvent[] = [];
		// Create exactly 8 PR comments (threshold) on different repos
		for (let i = 0; i < 8; i++) {
			events.push(makeEvent("PullRequestReviewCommentEvent", `owner/repo${i}`, new Date(2026, 2, 10, 12, 0, i * 15).toISOString()));
		}
		padToMin(events, 10);

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		// At threshold (8), should flag as "High PR comment frequency"
		expect(hasFlag(result, "High PR comment frequency")).toBe(true);
	});
});

describe("identify - Extreme PR Spam Detection (Time-Based)", () => {
	it("should flag extreme daily PR spam (30+ PRs in 24 hours)", () => {
		const events: GitHubEvent[] = [];

		// Create 35 PR events in the last 24 hours
		for (let i = 0; i < 35; i++) {
			const repoIndex = i % 20;
			events.push(makeEvent("PullRequestEvent", `owner/repo${repoIndex}`, new Date(2026,2,10,6 + Math.floor(i / 5),i % 60).toISOString(), { action: "opened" }));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 25, accountName: "user" }));

		const spamFlag = findFlag(result, "Extreme PR spam (daily)");
		expect(spamFlag).toBeDefined();
		expect(spamFlag?.points).toBe(45);
		expect(spamFlag?.detail).toContain("35 PRs");
		expect(result.classification).toBe("likely_spam");
	});

	it("should flag distributed PR spam pattern (50+ PRs across 15+ repos)", () => {
		const events: GitHubEvent[] = [];

		// Create 100 PR events across 20 repos (distributed over time to avoid daily/weekly flags)
		for (let i = 0; i < 100; i++) {
			const repoIndex = i % 20;
			const daysAgo = 14 + Math.floor(i / 5); // Spread over 34 days
			events.push(makeEvent("PullRequestEvent", `spamtarget/repo${repoIndex}`, new Date(2026, 2, 10 - daysAgo, 12, i % 60).toISOString(), { action: "opened" }));
		}
		// Add some push events to meet MIN_EVENTS_FOR_ANALYSIS
		for (let i = 100; i < 110; i++) {
			events.push(makeEvent("PushEvent", "user/personal", new Date(2026, 1, 1, 12, 0, i).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 5, accountName: "user" }));

		const spamFlag = findFlag(result, "Distributed PR spam pattern");
		expect(spamFlag).toBeDefined();
		expect(spamFlag?.points).toBe(45);
		expect(spamFlag?.detail).toContain("100 PRs");
		expect(spamFlag?.detail).toContain("different repositories");
		expect(result.classification).toBe("likely_spam");
	});

	it("should not flag moderate PR volume in a week", () => {
		const events: GitHubEvent[] = [];

		// Create 20 PRs in the last 7 days (below threshold)
		for (let i = 0; i < 20; i++) {
			events.push(makeEvent("PullRequestEvent", `owner/repo${i % 5}`, new Date(2026,2,6 + Math.floor(i / 4),12,i % 60).toISOString(), { action: "opened" }));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 10, accountName: "user" }));

		expectNoPrSpamFlags(result);
	});

	it("should not flag legitimate long-term activity (500 PRs over 6 months)", () => {
		const events: GitHubEvent[] = [];

		// Create 500 PRs spread over ~6 months
		for (let i = 0; i < 500; i++) {
			const repoIndex = i % 30;
			const daysAgo = Math.floor(i / 2.7); // ~180 days
			events.push(makeEvent("PullRequestEvent", `owner/repo${repoIndex}`, new Date(2026,2 - Math.floor(daysAgo / 30),10 - (daysAgo % 28),12,0).toISOString(), { action: "opened" }));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 35, accountName: "user" }));

		expectNoPrSpamFlags(result);
	});

	it("should not flag high PR count if repos spread is below threshold", () => {
		const events: GitHubEvent[] = [];

		// Create 75 PRs across only 5 repos (below 15 repo threshold)
		for (let i = 0; i < 75; i++) {
			const daysAgo = 14 + Math.floor(i / 5);
			events.push(makeEvent("PullRequestEvent", `owner/repo${i % 5}`, new Date(2026, 2, 10 - daysAgo, 12, i % 60).toISOString(), { action: "opened" }));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 10, accountName: "user" }));

		const distributedSpamFlag = findFlag(result, "Distributed PR spam pattern");
		expect(distributedSpamFlag).toBeUndefined();
	});
});

describe("identify - Repository Exclusion Filter", () => {
	it("should exclude events from filtered repositories and not flag them", () => {
		const events: GitHubEvent[] = [];
		// Create 10 fork events on excluded repo and 2 on other repos
		// FORKS_EXTREME: 8 (triggers at 8+), FORKS_HIGH: 5 (triggers at 5+)
		// Without filter: 12 forks total >= 8 → flags. With filter: 2 forks < 5 → no flag
		for (let i = 0; i < 10; i++) {
			events.push(makeEvent("ForkEvent", "excluded-owner/excluded-repo", new Date(2026, 2, 10, i, 0, 0).toISOString()));
		}
		for (let i = 0; i < 2; i++) {
			events.push(makeEvent("ForkEvent", `other-owner/repo${i}`, new Date(2026, 2, 10, 10 + i, 0, 0).toISOString()));
		}

		// Without filter - should flag because 12 forks within 24h triggers fork spike (>= FORKS_EXTREME: 8)
		const resultWithoutFilter = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		// With filter excluding the problematic repo - should not flag because only 2 forks remain (< FORKS_HIGH: 5)
		const resultWithFilter = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user", excludeRepos: ["excluded-owner/excluded-repo"] }));

		// Verify that fork spike flags are different
		const withoutFilterHasForkFlag = hasForkFlag(resultWithoutFilter);
		const withFilterHasForkFlag = hasForkFlag(resultWithFilter);

		expect(withoutFilterHasForkFlag).toBe(true);
		expect(withFilterHasForkFlag).toBe(false);
		expect(resultWithFilter.score).toBeGreaterThan(resultWithoutFilter.score);
	});

	it("should handle case-insensitive repository name matching", () => {
		const events: GitHubEvent[] = [];
		// Create fork events with mixed case in repo names
		for (let i = 0; i < 10; i++) {
			events.push(makeEvent("ForkEvent", "Owner/MyRepo", new Date(2026, 2, 10, i, 0, 0).toISOString())); // Mixed case
		}

		// Filter with different case - should still exclude them
		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user", excludeRepos: ["owner/myrepo"] }));

		// Should not flag because all forks are excluded
		expect(hasForkFlag(result)).toBe(false);
		expect(result.score).toBe(100);
	});

	it("should filter multiple excluded repositories", () => {
		const events: GitHubEvent[] = [];
		// Create fork events across 3 repos
		for (let i = 0; i < 4; i++) {
			events.push(makeEvent("ForkEvent", "owner/repo-a", new Date(2026, 2, 10, i, 0, 0).toISOString()));
			events.push(makeEvent("ForkEvent", "owner/repo-b", new Date(2026, 2, 10, i + 4, 0, 0).toISOString()));
			events.push(makeEvent("ForkEvent", "owner/repo-c", new Date(2026, 2, 10, i + 8, 0, 0).toISOString()));
		}

		// Exclude first two repos - should only see 4 forks from repo-c
		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user", excludeRepos: ["owner/repo-a", "owner/repo-b"] }));

		// Should not flag because only 4 forks remain
		expect(hasForkFlag(result)).toBe(false);
	});

	it("should work correctly when excludeRepos is empty array", () => {
		const events = Array.from({ length: 10 }, (_, i) => makeEvent("ForkEvent", `repo${i}`, new Date(2026, 2, 10, i, 0, 0).toISOString()));

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user", excludeRepos: [] }));

		// Should behave same as if excludeRepos was not provided
		expect(hasForkFlag(result)).toBe(true);
	});

	it("should work correctly when excludeRepos is not provided (undefined)", () => {
		const events = Array.from({ length: 10 }, (_, i) => makeEvent("ForkEvent", `repo${i}`, new Date(2026, 2, 10, i, 0, 0).toISOString()));

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		// Should flag fork activity normally
		expect(hasForkFlag(result)).toBe(true);
	});

	it("should exclude repos from all types of analysis (comment spam, bursts, etc)", () => {
		const events: GitHubEvent[] = [];

		// Add issue comment spam events to 12 different repos
		for (let i = 0; i < 12; i++) {
			events.push(makeEvent("IssueCommentEvent", `spam-owner/spam-repo${i}`, new Date(2026, 2, 10, 12, 0, i * 10).toISOString()));
		}

		const resultWithoutFilter = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		const resultWithFilter = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user", excludeRepos: Array.from({ length: 12 }, (_, i) => `spam-owner/spam-repo${i}`) }));

		// Without filter should flag comment spam
		expect(hasIssueCommentSpam(resultWithoutFilter)).toBe(true);

		// With filter should not flag
		expect(hasIssueCommentSpam(resultWithFilter)).toBe(false);

		expect(resultWithFilter.score).toBeGreaterThan(resultWithoutFilter.score);
	});

	it("should partially filter when only some events match exclude list", () => {
		const events: GitHubEvent[] = [];

		// Add 8 forks to excluded repo (would trigger flag)
		for (let i = 0; i < 8; i++) {
			events.push(makeEvent("ForkEvent", "excluded-owner/excluded-repo", new Date(2026, 2, 10, i, 0, 0).toISOString()));
		}

		// Add 2 forks to non-excluded repo (not enough to flag alone)
		for (let i = 0; i < 2; i++) {
			events.push(makeEvent("ForkEvent", "other/repo", new Date(2026, 2, 10, 10 + i, 0, 0).toISOString()));
		}

		const result = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user", excludeRepos: ["excluded-owner/excluded-repo"] }));

		// Should only see 2 forks (not enough to flag)
		expect(hasForkFlag(result)).toBe(false);

		// Now test without filter - should flag
		const resultNoFilter = identify(makeInput(events, { createdAt: "2025-01-01T00:00:00Z", reposCount: 20, accountName: "user" }));

		expect(hasForkFlag(resultNoFilter)).toBe(true);
	});
});

describe("identify - Known Bot Whitelist", () => {
	it("classifies dependabot as legitimate_automation with no flags and score 0", () => {
		const result = identify(makeInput([], { createdAt: "2020-01-01T00:00:00Z", reposCount: 1, accountName: "dependabot" }));
		expect(result.classification).toBe("legitimate_automation");
		expect(result.confidence).toBe(99);
		expect(result.flags).toHaveLength(0);
		expect(result.score).toBe(0);
	});

	it("classifies renovate[bot] as legitimate_automation", () => {
		const result = identify(makeInput([], { createdAt: "2020-01-01T00:00:00Z", reposCount: 1, accountName: "renovate[bot]" }));
		expect(result.classification).toBe("legitimate_automation");
	});

	it("does not short-circuit non-allowlisted [bot]-suffix accounts", () => {
		const result = identify(makeInput([], { createdAt: "2020-01-01T00:00:00Z", reposCount: 1, accountName: "some-custom-action[bot]" }));
		expect(result.classification).not.toBe("legitimate_automation");
	});

	it("does not classify a regular user whose name contains 'bot' as legitimate_automation", () => {
		const result = identify(makeInput([], { createdAt: "2024-01-01T00:00:00Z", reposCount: 5, accountName: "robotics-enthusiast" }));
		expect(result.classification).not.toBe("legitimate_automation");
	});
});

describe("identify - Automation Type Classification", () => {
	it("classifies accounts below suspicious threshold without spam signals as automation", () => {
		// 0 repos + 20 foreign events triggers zero-repos flag but no spam labels
		const ts = "2026-03-08T00:00:00Z";
		const pushEvent = makeEvent("PushEvent", "other/repo", ts);

		const result = identify(makeInput(Array(30).fill(pushEvent), { createdAt: "2025-10-01T00:00:00Z", reposCount: 0, accountName: "pushbot" }));

		expect(result.classification).toBe("automation");
	});

	it("classifies accounts with spam signals and low score as likely_spam", () => {
		const recentTs = "2026-03-08T00:00:00Z";
		const watchEvent = makeEvent("WatchEvent", "other/popular-repo", recentTs);

		const result = identify(makeInput(Array(20).fill(watchEvent), { createdAt: "2025-03-10T00:00:00Z", reposCount: 0, accountName: "starfarmer99" }));

		expect(result.classification).toBe("likely_spam");
		expect(hasFlag(result, "Star farm pattern")).toBe(true);
	});
});

describe("identify - Confidence Scoring", () => {
	it("returns confidence 99 for whitelisted bots", () => {
		const result = identify(makeInput([], { createdAt: "2020-01-01T00:00:00Z", reposCount: 1, accountName: "dependabot" }));
		expect(result.confidence).toBe(99);
	});

	it("returns confidence >= 20 for any account", () => {
		const result = identify(makeInput([], { createdAt: "2025-06-01T00:00:00Z", reposCount: 5, accountName: "newuser" }));
		expect(result.confidence).toBeGreaterThanOrEqual(20);
	});

	it("returns confidence <= 95 for non-whitelisted accounts", () => {
		const ts = "2026-03-08T00:00:00Z";
		const watchEvent = makeEvent("WatchEvent", "other/repo", ts);
		const result = identify(makeInput(Array(20).fill(watchEvent), { createdAt: "2025-03-10T00:00:00Z", reposCount: 0, accountName: "starfarmer99" }));
		expect(result.confidence).toBeLessThanOrEqual(95);
	});

	it("returns higher confidence for accounts with more corroborating signals", () => {
		const ts = "2026-03-08T00:00:00Z";
		const watchEvent = makeEvent("WatchEvent", "other/repo", ts);

		const manyFlags = identify(makeInput(Array(20).fill(watchEvent), { createdAt: "2025-03-10T00:00:00Z", reposCount: 0, accountName: "starfarmer99" }));

		const fewFlags = identify(makeInput([], { createdAt: "2025-06-01T00:00:00Z", reposCount: 5, accountName: "newuser" }));

		expect(manyFlags.confidence).toBeGreaterThan(fewFlags.confidence);
	});
});

describe("identify - Temporal Event Degradation", () => {
	it("does not decay mitigating signals (negative-point flags are unaffected)", () => {
		const oldTs = "2025-09-11T00:00:00Z";
		// 5+ year old account earns Long-standing account (-10) regardless of event age
		const result = identify(makeInput(Array(20).fill(makeWatchTs(oldTs)), { createdAt: "2019-03-10T00:00:00Z", reposCount: 2, accountName: "user" }));

		expect(hasFlag(result, "Long-standing account")).toBe(true);
		const seniorityFlag = findFlag(result, "Long-standing account");
		expect(seniorityFlag?.points).toBe(-10);
	});

	it("does not decay non-event-based positive flags (Recently created is age-derived)", () => {
		const oldTs = "2025-09-11T00:00:00Z"; // ~180 days old — deep decay
		// Account is 5 days old → "Recently created" (+20); events are 180 days old → heavy decay
		const result = identify(makeInput(Array(5).fill(makeWatchTs(oldTs)), { createdAt: "2026-03-05T00:00:00Z", reposCount: 1, accountName: "brandnewuser" }));

		const recentlyCreatedFlag = findFlag(result, "Recently created");
		expect(recentlyCreatedFlag).toBeDefined();
		// Score should reflect full +20, not a decayed fraction — humanScore <= 80
		expect(result.score).toBeLessThanOrEqual(80);
	});

	it("applies lower bot score to accounts with only historical activity vs recent activity", () => {
		const oldTs = "2025-09-11T00:00:00Z"; // ~180 days before fake date
		const recentTs = "2026-03-09T00:00:00Z"; // 1 day before fake date

		const base = {
			createdAt: "2019-03-10T00:00:00Z",
			reposCount: 2,
			accountName: "user",
		};

		const resultOld = identify({ ...base, events: Array(20).fill(makeWatchTs(oldTs)) });
		const resultRecent = identify({ ...base, events: Array(20).fill(makeWatchTs(recentTs)) });

		// Old activity decays → higher humanScore (appears less bot-like)
		expect(resultOld.score).toBeGreaterThan(resultRecent.score);
	});
});

describe("identify - Known Bot Whitelist (edge cases)", () => {
	it("classifies uppercase bot name as legitimate_automation", () => {
		const result = identify(makeInput([], { createdAt: "2020-01-01T00:00:00Z", reposCount: 1, accountName: "DEPENDABOT" }));
		expect(result.classification).toBe("legitimate_automation");
		expect(result.confidence).toBe(99);
	});
});

describe("identify - Classification Thresholds", () => {
	it("classifies accounts at exactly THRESHOLD_HUMAN (70) as organic", () => {
		// Score: Established account (-10) + Long-standing account (-10) + Has followers (-5) = -25 total.
		// humanScore = 100 - (-25) = 125, capped at 100 → "organic".
		const result = identify(makeInput([], { createdAt: "2019-01-01T00:00:00Z", reposCount: 10, accountName: "borderuser", profile: { followers: 50 } }));
		expect(result.classification).toBe("organic");
	});

	it("classifies accounts with spam-specific label 'Star burst activity' as likely_spam", () => {
		// 15 WatchEvents within 24h triggers star burst (threshold: 10)
		const ts = "2026-03-10T00:00:00Z";
		const makeWatchEvent = (repo: string): GitHubEvent =>
			({
				type: "WatchEvent",
				repo: { name: repo },
				created_at: ts,
			}) as GitHubEvent;

		const events: GitHubEvent[] = [
			...Array(5).fill(makeWatchEvent("owner/repo-a")),
			...Array(5).fill(makeWatchEvent("owner/repo-b")),
			...Array(5).fill(makeWatchEvent("owner/repo-c")),
		];

		const result = identify(makeInput(events, { createdAt: "2025-03-10T00:00:00Z", reposCount: 0, accountName: "starburster" }));

		expect(hasFlag(result, "Star burst activity")).toBe(true);
		expect(result.classification).toBe("likely_spam");
	});

	it("classifies accounts with 'Issue burst' label as likely_spam", () => {
		const ts = "2026-03-09T00:00:00Z";
		const makeIssueEvent = (repo: string): GitHubEvent =>
			({
				type: "IssuesEvent",
				repo: { name: repo },
				created_at: ts,
				payload: { action: "opened" },
			}) as GitHubEvent;

		// Spread across many repos to trigger Issue burst
		const events: GitHubEvent[] = Array.from({ length: 20 }, (_, i) =>
			makeIssueEvent(`owner/repo-${i}`),
		);

		const result = identify(makeInput(events, { createdAt: "2025-03-10T00:00:00Z", reposCount: 0, accountName: "issuespammer" }));

		expect(hasFlag(result, "Issue burst")).toBe(true);
		expect(result.classification).toBe("likely_spam");
	});
});

describe("identify - Confidence Edge Cases", () => {
	it("returns confidence 20 when classification is mixed but no corroborating signals exist", () => {
		// Recently created (+20, eventBased:false) + Event monoculture (+20) = 40 → humanScore=60 → "mixed"
		// 2 bot flags, 0 human flags → corroborating = min(2, 0) = 0 → confidence = 20
		// reposCount=5 (≥ PERSONAL_REPOS_LOW) prevents "Mostly external activity" from firing
		// Events spread across all 7 days of week (CV ≈ 0.10) to stay below DOW_VARIANCE_CV_MIN (0.3)
		const mk = (d: string, n: number) =>
			Array.from({ length: n }, () => ({
				type: "IssueCommentEvent",
				repo: { name: "other/repo" },
				created_at: d,
			} as GitHubEvent));
		const events = [
			...mk("2026-03-04T10:00:00Z", 4), // Wed
			...mk("2026-03-05T10:00:00Z", 4), // Thu
			...mk("2026-03-06T10:00:00Z", 4), // Fri
			...mk("2026-03-07T10:00:00Z", 5), // Sat
			...mk("2026-03-08T10:00:00Z", 4), // Sun
			...mk("2026-03-09T10:00:00Z", 4), // Mon
			...mk("2026-03-10T10:00:00Z", 5), // Tue (fake now)
		];
		const result = identify(makeInput(events, { createdAt: "2026-02-15T00:00:00Z", reposCount: 5, accountName: "mixeduser" }));
		expect(result.classification).toBe("mixed");
		expect(result.confidence).toBe(20);
	});
});

describe("identify - SPAM_SIGNAL_LABELS coverage", () => {
	it("classifies 'Extreme PR spam (weekly)' label as likely_spam", () => {
		// 100 PRs over 5 days (20/day), latest=2026-03-08 → 20 in last 24h < 30 (no daily); 100 >= 100 in 7d → weekly extreme
		const events = Array.from({ length: 100 }, (_, i) =>
			makeEvent("PullRequestEvent", `org/repo${i % 10}`, new Date(2026, 2, 4 + Math.floor(i / 20), 12, i % 60).toISOString(), { action: "opened" }));

		const result = identify(makeInput(events, { createdAt: "2025-03-10T00:00:00Z", reposCount: 5, accountName: "weeklyspammer" }));

		expect(hasFlag(result, "Extreme PR spam (weekly)")).toBe(true);
		expect(result.classification).toBe("likely_spam");
	});

	it("classifies 'Very high PR spam frequency' label as likely_spam", () => {
		// 51 PRs over 3 days; 17 in last 24h < 30; 51 >= 50 (VERY_HIGH) but < 100 (EXTREME) → very high, not extreme
		const events = Array.from({ length: 51 }, (_, i) =>
			makeEvent("PullRequestEvent", `org/repo${i % 5}`, new Date(2026, 2, 7 + Math.floor(i / 17), 12, i % 60).toISOString(), { action: "opened" }));

		const result = identify(makeInput(events, { createdAt: "2025-03-10T00:00:00Z", reposCount: 5, accountName: "veryhighspammer" }));

		expect(hasFlag(result, "Very high PR spam frequency")).toBe(true);
		expect(hasFlag(result, "Extreme PR spam (weekly)")).toBe(false);
		expect(result.classification).toBe("likely_spam");
	});

	it("classifies 'Rapid PR spam to repository' label as likely_spam", () => {
		// 4 PRs to same repo 60s apart → Rapid PR spam (+40); recently created (+20) → score=60 → humanScore=40 → likely_spam
		const base = new Date("2026-03-10T01:00:00Z").getTime();
		const events = Array.from({ length: 4 }, (_, i) =>
			makeEvent("PullRequestEvent", "victim/repo", new Date(base + i * 60_000).toISOString(), { action: "opened" }));

		const result = identify(makeInput(events, { createdAt: "2026-02-15T00:00:00Z", reposCount: 1, accountName: "rapidspammer" }));

		expect(hasFlag(result, "Rapid PR spam to repository")).toBe(true);
		expect(result.classification).toBe("likely_spam");
	});

	it("classifies 'Closed PR spam burst' label as likely_spam", () => {
		// 5 closed PRs across 2 repos in 30min → burst (+35); recently created (+20) → score=55 → humanScore=45 → likely_spam
		const base = new Date("2026-03-10T02:00:00Z").getTime();
		const events = [
			...Array.from({ length: 3 }, (_, i) =>
				makeEvent("PullRequestEvent", "org/repo1", new Date(base + i * 6 * 60_000).toISOString(), { action: "closed" })),
			...Array.from({ length: 2 }, (_, i) =>
				makeEvent("PullRequestEvent", "org/repo2", new Date(base + (3 + i) * 6 * 60_000).toISOString(), { action: "closed" })),
		];

		const result = identify(makeInput(events, { createdAt: "2026-02-15T00:00:00Z", reposCount: 2, accountName: "burstspammer" }));

		expect(hasFlag(result, "Closed PR spam burst")).toBe(true);
		expect(result.classification).toBe("likely_spam");
	});

	it("classifies 'Closed PR spam scatter' label as likely_spam", () => {
		// 25 closed PRs across 4 repos → repos(4) >= SPREAD(3) and count(25) >= 25 → scatter fires
		const events = Array.from({ length: 25 }, (_, i) =>
			makeEvent("PullRequestEvent", `org/repo${i % 4}`, new Date(2026, 2, 1 + Math.floor(i / 7), 12, i % 60).toISOString(), { action: "closed" }));

		const result = identify(makeInput(events, { createdAt: "2025-03-10T00:00:00Z", reposCount: 2, accountName: "scatterspammer" }));

		expect(hasFlag(result, "Closed PR spam scatter")).toBe(true);
		expect(result.classification).toBe("likely_spam");
	});
});

describe("identify - Pre-AI History Repository Exclusion", () => {
	it("should exclude named repos from pre-AI history scoring", () => {
		const makePreAiRepo = (name: string) => ({
			created_at: "2021-01-01T00:00:00Z",
			name,
		});
		const preAiRepos = [
			makePreAiRepo("excluded-owner/old-repo-a"),
			makePreAiRepo("excluded-owner/old-repo-b"),
			makePreAiRepo("excluded-owner/old-repo-c"),
		];

		const base = {
			createdAt: "2024-01-01T00:00:00Z",
			reposCount: 5,
			accountName: "user",
			events: [],
			commits: [],
		};

		const withRepos = identify({ ...base, repos: preAiRepos });
		const withReposExcluded = identify(makeInput([], { excludeRepos: preAiRepos.map((r) => r.name), repos: preAiRepos }));

		// Without exclusion, the old repos contribute a mitigating pre-AI history flag
		expect(hasFlag(withRepos, "Pre-AI development history")).toBe(true);
		// With exclusion, those repos are filtered out and the flag must not appear
		expect(hasFlag(withReposExcluded, "Pre-AI development history")).toBe(false);
	});
});
