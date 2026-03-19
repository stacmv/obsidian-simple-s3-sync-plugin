import { App, Platform, PluginSettingTab, Setting } from "obsidian";
import type SimpleS3SyncPlugin from "./main";

export interface S3SyncSettings {
	s3Endpoint: string;
	s3Region: string;
	s3Bucket: string;
	s3Prefix: string;
	s3AccessKey: string;
	s3SecretKey: string;

	deviceName: string;
	syncIntervalMinutes: number;

	includePatterns: string[];
	excludePatterns: string[];

	mergeStrategy: "keep-both" | "3way-merge";
}

export const DEFAULT_SETTINGS: S3SyncSettings = {
	s3Endpoint: "",
	s3Region: "us-east-1",
	s3Bucket: "",
	s3Prefix: "vault",
	s3AccessKey: "",
	s3SecretKey: "",

	deviceName: Platform.isMobile ? "mobile" : "desktop",
	syncIntervalMinutes: 0,

	includePatterns: [],
	excludePatterns: [".obsidian/**", ".trash/**"],

	mergeStrategy: Platform.isMobile ? "keep-both" : "3way-merge",
};

export class S3SyncSettingTab extends PluginSettingTab {
	plugin: SimpleS3SyncPlugin;

	constructor(app: App, plugin: SimpleS3SyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Simple S3 Sync" });

		// --- S3 Connection ---
		containerEl.createEl("h3", { text: "S3 Connection" });

		new Setting(containerEl)
			.setName("Endpoint")
			.setDesc("S3-compatible endpoint URL (e.g. https://s3.amazonaws.com)")
			.addText((text) =>
				text
					.setPlaceholder("https://s3.amazonaws.com")
					.setValue(this.plugin.settings.s3Endpoint)
					.onChange(async (value) => {
						this.plugin.settings.s3Endpoint = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Region")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.s3Region)
					.onChange(async (value) => {
						this.plugin.settings.s3Region = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Bucket")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.s3Bucket)
					.onChange(async (value) => {
						this.plugin.settings.s3Bucket = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Key prefix")
			.setDesc("All files stored under this prefix in the bucket")
			.addText((text) =>
				text
					.setPlaceholder("vault")
					.setValue(this.plugin.settings.s3Prefix)
					.onChange(async (value) => {
						this.plugin.settings.s3Prefix = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Access Key")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.s3AccessKey)
					.onChange(async (value) => {
						this.plugin.settings.s3AccessKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Secret Key")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setValue(this.plugin.settings.s3SecretKey)
					.onChange(async (value) => {
						this.plugin.settings.s3SecretKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		// --- Device ---
		containerEl.createEl("h3", { text: "Device" });

		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Unique name for this device (e.g. desktop, mobile)")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.deviceName)
					.onChange(async (value) => {
						this.plugin.settings.deviceName = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-sync interval (minutes)")
			.setDesc("0 = manual only")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.syncIntervalMinutes))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n >= 0) {
							this.plugin.settings.syncIntervalMinutes = n;
							await this.plugin.saveSettings();
							this.plugin.setupInterval();
						}
					})
			);

		// --- Filters ---
		containerEl.createEl("h3", { text: "File Filters" });

		new Setting(containerEl)
			.setName("Include patterns")
			.setDesc(
				"Glob patterns, one per line. Empty = include all. Example: **/*.md"
			)
			.addTextArea((text) =>
				text
					.setValue(this.plugin.settings.includePatterns.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.includePatterns = value
							.split("\n")
							.map((s) => s.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Exclude patterns")
			.setDesc("Glob patterns, one per line. Example: .obsidian/**")
			.addTextArea((text) =>
				text
					.setValue(this.plugin.settings.excludePatterns.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.excludePatterns = value
							.split("\n")
							.map((s) => s.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					})
			);

		// --- Merge ---
		containerEl.createEl("h3", { text: "Conflict Resolution" });

		new Setting(containerEl)
			.setName("Merge strategy")
			.setDesc(
				"3way-merge: auto-merge markdown on desktop. keep-both: always create conflict copies."
			)
			.addDropdown((dd) =>
				dd
					.addOption("3way-merge", "3-way merge (desktop)")
					.addOption("keep-both", "Keep both copies")
					.setValue(this.plugin.settings.mergeStrategy)
					.onChange(async (value) => {
						this.plugin.settings.mergeStrategy = value as S3SyncSettings["mergeStrategy"];
						await this.plugin.saveSettings();
					})
			);
	}
}
