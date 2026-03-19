import { merge } from "node-diff3";

export interface MergeResult {
	success: boolean;
	content: string;
}

export function mergeMarkdown(
	ours: string,
	ancestor: string,
	theirs: string
): MergeResult {
	const result = merge(ours, ancestor, theirs, {
		stringSeparator: /\n/,
	} as any);

	const merged = result.result.join("\n");
	const hasConflicts =
		merged.includes("<<<<<<<") || merged.includes(">>>>>>>");

	return { success: !hasConflicts, content: merged };
}
