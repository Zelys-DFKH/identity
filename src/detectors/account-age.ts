import { CONFIG } from "../config";
import type { IdentifyFlag } from "../types";

function ageFlag(age: number, label: string, points: number): IdentifyFlag {
	return { label, points, detail: `Account is ${age} days old`, eventBased: false };
}

export function detectAccountAge(accountAge: number): IdentifyFlag[] {
	if (accountAge < CONFIG.AGE_NEW_ACCOUNT) {
		return [ageFlag(accountAge, "Recently created", CONFIG.POINTS_NEW_ACCOUNT)];
	}
	if (accountAge < CONFIG.AGE_YOUNG_ACCOUNT) {
		return [ageFlag(accountAge, "Young account", CONFIG.POINTS_YOUNG_ACCOUNT)];
	}
	return [];
}

export function detectAccountSeniority(accountAge: number): IdentifyFlag[] {
	const flags: IdentifyFlag[] = [];
	if (accountAge >= CONFIG.AGE_SENIOR_ACCOUNT) {
		flags.push({ label: "Established account", points: CONFIG.POINTS_SENIOR_ACCOUNT,
			detail: `Account is ${accountAge} days old (3+ years)`, eventBased: false });
	}
	if (accountAge >= CONFIG.AGE_VETERAN_ACCOUNT) {
		flags.push({ label: "Long-standing account", points: CONFIG.POINTS_VETERAN_ACCOUNT,
			detail: `Account is ${accountAge} days old (5+ years)`, eventBased: false });
	}
	return flags;
}
