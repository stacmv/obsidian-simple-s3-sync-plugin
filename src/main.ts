import { Notice, Plugin } from "obsidian";
import { S3SyncSettings, DEFAULT_SETTINGS, S3SyncSettingTab } from "./settings";
import { createS3Client, getLock, deleteLock } from "./s3";
import { isLockStale } from "./manifest";
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

		this.addCommand({
			id: "release-lock",
			name: "Release sync lock (force)",
			callback: () => this.doReleaseLock(),
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

	/**
	 * Force-clear a leaked/stuck advisory lock on S3.
	 *
	 * A sync that dies after acquiring the lock but before its finally releases
	 * it (mobile app suspended, network drop on the final delete) leaves
	 * `.sync-lock.json` behind, blocking other devices until it goes stale. This
	 * gives the user an explicit escape hatch instead of waiting out the 5-minute
	 * stale window. It reports who holds the lock and whether it was already
	 * stale, so the user knows what they cleared.
	 */
	private async doReleaseLock() {
		if (!this.s3Client) {
			new Notice("Simple S3 Sync: configure S3 settings first");
			return;
		}
		const { s3Bucket, s3Prefix } = this.settings;
		try {
			const lock = await getLock(this.s3Client, s3Bucket, s3Prefix);
			if (!lock) {
				new Notice("S3 Sync: no lock is currently held");
				return;
			}
			await deleteLock(this.s3Client, s3Bucket, s3Prefix);
			if (isLockStale(lock)) {
				new Notice(
					`S3 Sync: released stale lock held by "${lock.deviceName}"`
				);
			} else {
				// A fresh lock may belong to a device syncing right now; forcing
				// it removes the guard both devices rely on.
				new Notice(
					`S3 Sync: released FRESH lock held by "${lock.deviceName}" — ` +
						`if that device is syncing right now, let its sync finish before you sync.`
				);
			}
		} catch (e: any) {
			new Notice(`S3 Sync: failed to release lock — ${e.message}`);
			console.error("S3 Sync release-lock error:", e);
		}
	}
}
