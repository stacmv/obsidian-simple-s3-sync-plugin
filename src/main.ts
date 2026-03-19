import { Notice, Plugin } from "obsidian";
import { S3SyncSettings, DEFAULT_SETTINGS, S3SyncSettingTab } from "./settings";
import { createS3Client } from "./s3";
import { runSync } from "./sync";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SyncManifest } from "./manifest";

interface CachedData {
	settings: S3SyncSettings;
	localManifest?: { manifest: SyncManifest };
}

export default class SimpleS3SyncPlugin extends Plugin {
	settings: S3SyncSettings = DEFAULT_SETTINGS;
	private s3Client: S3Client | null = null;
	private intervalId: number | null = null;
	private syncing = false;

	async onload() {
		await this.loadSettings();
		this.initS3Client();

		this.addRibbonIcon("refresh-cw", "Simple S3 Sync", () =>
			this.doSync()
		);

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => this.doSync(),
		});

		this.addSettingTab(new S3SyncSettingTab(this.app, this));
		this.setupInterval();
	}

	onunload() {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
		}
	}

	async loadSettings() {
		const data: Partial<CachedData> = (await this.loadData()) ?? {};
		this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
	}

	async saveSettings() {
		const data = await this.loadFullData();
		data.settings = this.settings;
		await this.saveData(data);
		this.initS3Client();
	}

	private async loadFullData(): Promise<CachedData> {
		return ((await this.loadData()) as CachedData) ?? { settings: this.settings };
	}

	private initS3Client() {
		const s = this.settings;
		if (s.s3Endpoint && s.s3Bucket && s.s3AccessKey && s.s3SecretKey) {
			this.s3Client = createS3Client(
				s.s3Endpoint,
				s.s3Region,
				s.s3AccessKey,
				s.s3SecretKey
			);
		} else {
			this.s3Client = null;
		}
	}

	setupInterval() {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		if (this.settings.syncIntervalMinutes > 0) {
			this.intervalId = window.setInterval(
				() => this.doSync(),
				this.settings.syncIntervalMinutes * 60 * 1000
			);
		}
	}

	private async doSync() {
		if (this.syncing) {
			new Notice("Sync already in progress");
			return;
		}
		if (!this.s3Client) {
			new Notice("Simple S3 Sync: configure S3 settings first");
			return;
		}

		this.syncing = true;
		const statusBar = this.addStatusBarItem();
		statusBar.setText("S3 Sync...");

		try {
			const fullData = await this.loadFullData();

			const result = await runSync(
				this.app,
				this.s3Client,
				this.settings,
				fullData.localManifest ?? null,
				async (cached) => {
					fullData.localManifest = cached;
					await this.saveData(fullData);
				}
			);

			const parts: string[] = [];
			if (result.pulled) parts.push(`${result.pulled}↓`);
			if (result.pushed) parts.push(`${result.pushed}↑`);
			if (result.conflicts) parts.push(`${result.conflicts} conflicts`);
			if (result.errors.length) parts.push(`${result.errors.length} errors`);

			new Notice(
				parts.length > 0
					? `S3 Sync: ${parts.join(" ")}`
					: "S3 Sync: up to date"
			);

			if (result.errors.length) {
				console.error("S3 Sync errors:", result.errors);
			}
		} catch (e: any) {
			new Notice(`S3 Sync failed: ${e.message}`);
			console.error("S3 Sync error:", e);
		} finally {
			this.syncing = false;
			statusBar.remove();
		}
	}
}
