export class TFile {
	path = "";
	stat = { mtime: 0, size: 0 };
}

export class App {}
export class PluginSettingTab {}
export class Setting {}

export class Notice {
	constructor(public message: string) {}
}

export const Platform = { isMobile: false };

export function normalizePath(p: string): string {
	return p;
}

// Obsidian polyfills String.prototype.contains; mirror it so src code that uses
// `path.contains("/")` works in node tests.
if (!(String.prototype as any).contains) {
	(String.prototype as any).contains = function (this: string, s: string) {
		return this.indexOf(s) !== -1;
	};
}
