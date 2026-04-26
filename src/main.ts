import { Notice, Plugin } from "obsidian";
import { S3SyncSettings, DEFAULT_SETTINGS, S3SyncSettingTab } from "./settings";
import { createS3Client } from "./s3";
import { runSync, SyncResult } from "./sync";
import { SyncProgressModal } from "./modal";
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
	private activeModal: SyncProgressModal | null = null;

	async onload() {
		await this.loadSettings();
		this.initS3Client();

		// Manual sync: open progress modal immediately
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
				// Auto sync runs silently without modal
				() => this.doSyncSilent(),
				this.settings.syncIntervalMinutes * 60 * 1000
			);
		}
	}

	/** Manual sync: open progress modal that handles the full lifecycle. */
	private async doSync() {
		if (!this.s3Client) {
			new Notice("Simple S3 Sync: configure S3 settings first");
			return;
		}
		if (this.syncing) {
			// Sync already running — bring existing modal to front if available
			if (this.activeModal) {
				this.activeModal.bringToFront();
			} else {
				new Notice("Sync already in progress");
			}
			return;
		}
		this.syncing = true;

		const fullData = await this.loadFullData();
		const cachedManifest =
			fullData.localManifest?.manifest ??
			createEmptyManifest(this.settings.deviceName);

		this.activeModal = new SyncProgressModal(
			this.app,
			this.s3Client,
			this.settings,
			cachedManifest,
			async (cached) => {
				fullData.localManifest = cached;
				await this.saveData(fullData);
			},
			(result) => {
				this.syncing = false;
				this.activeModal = null;
				if (result?.errors.length) {
					console.error("S3 Sync errors:", result.errors);
				}
			}
		);
		this.activeModal.open();
	}

	/** Silent sync for auto-interval (no modal, status bar only). */
	async doSyncSilent() {
		if (!this.s3Client) return;
		if (this.syncing) return;
		this.syncing = true;
		const statusBar = this.addStatusBarItem();
		statusBar.setText("S3 Sync: connecting...");

		const updateStatusBar = (step: 3 | 4 | 5 | 6, detail: string, r: SyncResult) => {
			statusBar.setText(`S3 Sync: ${detail}`);
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
