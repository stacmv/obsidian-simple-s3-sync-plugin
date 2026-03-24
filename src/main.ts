import { Notice, Plugin } from "obsidian";
import { S3SyncSettings, DEFAULT_SETTINGS, S3SyncSettingTab } from "./settings";
import { createS3Client } from "./s3";
import { runSync, SyncResult } from "./sync";
import { computeSyncPlan } from "./plan";
import { SyncPlanModal } from "./modal";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SyncManifest } from "./manifest";
import { createEmptyManifest } from "./manifest";

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

		// Manual sync: show preview modal first
		this.addRibbonIcon("refresh-cw", "Simple S3 Sync", () =>
			this.doSyncWithPreview()
		);

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => this.doSyncWithPreview(),
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
				// Auto sync runs silently without preview modal
				() => this.doSyncDirect(),
				this.settings.syncIntervalMinutes * 60 * 1000
			);
		}
	}

	/** Manual sync: compute plan and show preview modal, then execute on confirm. */
	private async doSyncWithPreview() {
		if (!this.s3Client) {
			new Notice("Simple S3 Sync: configure S3 settings first");
			return;
		}
		if (this.syncing) {
			new Notice("Sync already in progress");
			return;
		}
		this.syncing = true;
		const statusBar = this.addStatusBarItem();
		statusBar.setText("S3 Sync: checking for changes...");

		try {
			const fullData = await this.loadFullData();
			const cachedManifest =
				fullData.localManifest?.manifest ??
				createEmptyManifest(this.settings.deviceName);
			const plan = await computeSyncPlan(
				this.app,
				this.s3Client,
				this.settings,
				cachedManifest
			);
			statusBar.remove();
			this.syncing = false;

			new SyncPlanModal(this.app, plan, () => this.doSyncDirect()).open();
		} catch (e: any) {
			new Notice(`S3 Sync failed: ${e.message}`);
			console.error("S3 Sync error:", e);
			this.syncing = false;
			statusBar.remove();
		}
	}

	/** Execute sync directly (used by auto-interval and after modal confirmation). */
	async doSyncDirect() {
		if (!this.s3Client) {
			new Notice("Simple S3 Sync: configure S3 settings first");
			return;
		}
		if (this.syncing) {
			new Notice("Sync already in progress");
			return;
		}
		this.syncing = true;
		const statusBar = this.addStatusBarItem();
		statusBar.setText("S3 Sync: connecting...");

		const updateStatusBar = (phase: string, r: SyncResult) => {
			const counts: string[] = [];
			if (r.pulled) counts.push(`${r.pulled} downloaded`);
			if (r.pushed) counts.push(`${r.pushed} uploaded`);
			if (r.conflicts) counts.push(`${r.conflicts} conflicts`);
			const label = counts.length ? counts.join(", ") : "...";
			statusBar.setText(`S3 Sync ${phase}: ${label}`);
		};

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
				},
				updateStatusBar
			);

			const parts: string[] = [];
			if (result.pulled) parts.push(`${result.pulled} downloaded`);
			if (result.pushed) parts.push(`${result.pushed} uploaded`);
			if (result.conflicts) parts.push(`${result.conflicts} conflicts`);
			if (result.errors.length) parts.push(`${result.errors.length} errors`);

			new Notice(
				parts.length > 0
					? `S3 Sync: ${parts.join(", ")}`
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
