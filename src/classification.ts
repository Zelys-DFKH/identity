import type { IdentityClassification } from "./types";

const DETAILS: Record<
	IdentityClassification,
	{ label: string; description: string }
> = {
	organic: {
		label: "Organic activity",
		description: "No automation signals detected in the analyzed events.",
	},
	mixed: {
		label: "Mixed activity",
		description:
			"Activity patterns show a mix of organic and automated signals.",
	},
	automation: {
		label: "Automation signals",
		description: "Activity patterns show signs of automation.",
	},
	likely_spam: {
		label: "Automation signals",
		description: "Activity patterns show signs of automation.",
	},
	legitimate_automation: {
		label: "Automation signals",
		description: "Activity patterns show signs of automation.",
	},
};

export function getClassificationDetails(
	classification: IdentityClassification | undefined,
) {
	return (
		DETAILS[classification as IdentityClassification] ?? {
			label: "Analysis unavailable",
			description: "Classification is not available for this account.",
		}
	);
}
