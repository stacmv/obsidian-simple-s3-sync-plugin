export class TFile {
	path = "";
	stat = { mtime: 0, size: 0 };
}

export class App {}
export class PluginSettingTab {}
export class Setting {}

export const Platform = { isMobile: false };

export function normalizePath(p: string): string {
	return p;
}
