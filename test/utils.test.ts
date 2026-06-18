import { describe, expect, it } from "vitest";
import { computeActivityRecencyMultiplier } from "../src/utils";

describe("computeActivityRecencyMultiplier", () => {
	it("returns 1 for empty events", () => {
		expect(computeActivityRecencyMultiplier([], 90)).toBe(1);
	});

	it("treats missing created_at as weight 1", () => {
		const result = computeActivityRecencyMultiplier([{ created_at: null }, { created_at: undefined }], 90);
		expect(result).toBe(1);
	});

	it("does not produce NaN for malformed created_at", () => {
		const result = computeActivityRecencyMultiplier([{ created_at: "not-a-date" }], 90);
		expect(Number.isNaN(result)).toBe(false);
		expect(result).toBe(1);
	});

	it("returns a value between 0 and 1 for old events", () => {
		const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
		const result = computeActivityRecencyMultiplier([{ created_at: old }], 90);
		expect(result).toBeGreaterThan(0);
		expect(result).toBeLessThan(1);
	});

	it("returns close to 1 for very recent events", () => {
		const recent = new Date(Date.now() - 60 * 1000).toISOString();
		const result = computeActivityRecencyMultiplier([{ created_at: recent }], 90);
		expect(result).toBeCloseTo(1, 3);
	});

	it("returns 1 when halfLifeDays is non-positive", () => {
		const now = new Date().toISOString();
		expect(computeActivityRecencyMultiplier([{ created_at: now }], 0)).toBe(1);
		expect(computeActivityRecencyMultiplier([{ created_at: now }], -5)).toBe(1);
	});

	it("returns exactly 1 for future timestamps (age clamped to zero)", () => {
		const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
		const result = computeActivityRecencyMultiplier([{ created_at: future }], 90);
		expect(result).toBe(1);
	});
});

import { matchConsecutivePairsInWindow } from "../src/utils";

describe("matchConsecutivePairsInWindow", () => {
	it("returns 0 matches for empty arrays", () => {
		const result = matchConsecutivePairsInWindow([], [], 60);
		expect(result.matchCount).toBe(0);
		expect(result.maxTimeDiff).toBe(0);
	});

	it("excludes pairs at exact window boundary (off-by-one boundary test)", () => {
		const base = new Date("2024-01-01T00:00:00Z").getTime();
		// Create a source event and a target event exactly 60 seconds apart
		const source = [{ created_at: new Date(base).toISOString() }];
		const target = [{ created_at: new Date(base + 60 * 1000).toISOString() }];

		// With windowSeconds = 60, an event exactly 60 seconds away should NOT match
		// because the window is [0, 60) not [0, 60]
		const result = matchConsecutivePairsInWindow(source, target, 60);
		expect(result.matchCount).toBe(0);
		expect(result.maxTimeDiff).toBe(0);
	});

	it("includes pairs within window boundary", () => {
		const base = new Date("2024-01-01T00:00:00Z").getTime();
		// Create a source event and a target event 59 seconds apart
		const source = [{ created_at: new Date(base).toISOString() }];
		const target = [{ created_at: new Date(base + 59 * 1000).toISOString() }];

		// With windowSeconds = 60, an event 59 seconds away SHOULD match
		const result = matchConsecutivePairsInWindow(source, target, 60);
		expect(result.matchCount).toBe(1);
		expect(result.maxTimeDiff).toBe(59);
	});
});
