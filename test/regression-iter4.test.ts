import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { detectCommentSpam } from "../src/detectors/comment-spam";
import type { GitHubEvent } from "../src/types";

const date = new Date(2026, 2, 10, 12);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(date);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("comment-spam: burst index alignment (comment-spam.ts line 15-23)", () => {
	it("detects spray from 15 comments across 15 repos in 2 min window", () => {
		const events: GitHubEvent[] = Array.from({ length: 15 }, (_, i) => ({
			type: "IssueCommentEvent",
			created_at: new Date(2026, 2, 10, 12, 0, i % 60).toISOString(),
			repo: { name: `repo-${i}` },
		} as any));
		const flags = detectCommentSpam(events);
		expect(flags.length).toBeGreaterThan(0);
		expect(flags.some((f) => f.label === "Issue comment spam")).toBe(true);
	});

	it("detects spray correctly when input events are unsorted by time", () => {
		const events: GitHubEvent[] = [
			{ type: "IssueCommentEvent", created_at: new Date(2026, 2, 10, 13, 1).toISOString(), repo: { name: "repo-2" } } as any,
			{ type: "IssueCommentEvent", created_at: new Date(2026, 2, 10, 13, 0).toISOString(), repo: { name: "repo-1" } } as any,
			{ type: "IssueCommentEvent", created_at: new Date(2026, 2, 10, 13, 2).toISOString(), repo: { name: "repo-3" } } as any,
			...Array.from({ length: 12 }, (_, i) => ({
				type: "IssueCommentEvent",
				created_at: new Date(2026, 2, 10, 13, (i % 2) + 3).toISOString(),
				repo: { name: `repo-${i + 4}` },
			} as any)),
		];
		const flags = detectCommentSpam(events);
		expect(flags.length).toBeGreaterThan(0);
	});
});
