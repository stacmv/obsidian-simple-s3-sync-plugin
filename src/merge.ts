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
	const oursLines = ours.split("\n");
	const ancestorLines = ancestor.split("\n");
	const theirsLines = theirs.split("\n");

	const result = merge(oursLines, ancestorLines, theirsLines);

	return {
		success: !result.conflict,
		content: result.result.join("\n"),
	};
}
