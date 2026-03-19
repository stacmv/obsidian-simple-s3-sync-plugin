import picomatch from "picomatch";

const ALWAYS_EXCLUDE = [
	".obsidian/plugins/*/data.json",
	".sync-manifest.json",
	".sync-ancestors/**",
	".sync-lock.json",
];

export function shouldSyncFile(
	path: string,
	includePatterns: string[],
	excludePatterns: string[]
): boolean {
	const allExcludes = [...excludePatterns, ...ALWAYS_EXCLUDE];
	const isExcluded = picomatch(allExcludes);
	if (isExcluded(path)) return false;

	if (includePatterns.length === 0) return true;

	const isIncluded = picomatch(includePatterns);
	return isIncluded(path);
}
