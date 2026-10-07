import { App, Modal, Notice, Plugin } from "obsidian";
import { S3SyncSettings, DEFAULT_SETTINGS, S3SyncSettingTab } from "./settings";
import { createS3Client, getLock, deleteLock } from "./s3";
import { isLockStale } from "./manifest";
import { SyncProgressModal } from "./modal";
import { BackgroundSync, BackgroundSnapshot } from "./background";
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
	private background: BackgroundSync | null = null;

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

		this.addCommand({
			id: "reset-sync-state",
			name: "Reset local sync state (forget cached manifest)",
			callback: () => this.doResetSyncState(),
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
			// Sync already running — bring existing modal to front, or bring the
			// auto-sync to the foreground so it can be watched and cancelled
			if (this.activeModal) {
				this.activeModal.bringToFront();
			} else if (this.background && !this.background.finished) {
				this.attachToBackground(this.background);
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

	/** Opens the progress modal on top of an auto-sync already in flight. */
	private attachToBackground(background: BackgroundSync) {
		const modal = new SyncProgressModal(
			this.app,
			this.s3Client!,
			this.settings,
			createEmptyManifest(this.settings.deviceName), // unused when attached
			async () => {},
			() => {
				// Only stop tracking the modal: the background run owns `syncing`
				if (this.activeModal === modal) this.activeModal = null;
			},
			background
		);
		this.activeModal = modal;
		modal.open();
	}

	/** Silent sync for auto-interval (no modal, status bar only). */
	async doSyncSilent() {
		if (!this.s3Client) return;
		if (this.syncing) return;
		this.syncing = true;

		let fullData: CachedData | null = null;
		const background = new BackgroundSync(this.app, this.s3Client, this.settings, {
			loadCachedManifest: async () => {
				fullData = await this.loadFullData();
				return fullData.localManifest?.manifest ?? createEmptyManifest(this.settings.deviceName);
			},
			saveCachedData: async (cached) => {
				fullData!.localManifest = cached;
				await this.saveData(fullData);
			},
		});
		this.background = background;

		const statusBar = this.addStatusBarItem();
		const unsubscribe = background.subscribe((s) => {
			if (s.detail) statusBar.setText(`S3 Sync: ${s.detail}`);
		});

		try {
			const final = await background.run();
			// An attached modal already shows the outcome; notify only otherwise
			if (this.activeModal?.watching !== background) new Notice(this.describeBackgroundOutcome(final));
			if (final.phase === "error") console.error("S3 Sync error:", final.errorMessage);
			if (final.result?.errors.length) console.error("S3 Sync errors:", final.result.errors);
		} finally {
			unsubscribe();
			statusBar.remove();
			this.background = null;
			this.syncing = false;
		}
	}

	private describeBackgroundOutcome(s: BackgroundSnapshot): string {
		if (s.phase === "cancelled") return "S3 Sync: cancelled";
		if (s.phase === "error") return `S3 Sync failed: ${s.errorMessage}`;
		const r = s.result;
		const parts: string[] = [];
		if (r?.pulled) parts.push(`${r.pulled} downloaded`);
		if (r?.pushed) parts.push(`${r.pushed} uploaded`);
		if (r?.conflicts) parts.push(`${r.conflicts} conflicts`);
		if (r?.deferredDeletions)
			parts.push(
				`${r.deferredDeletions} deletion${r.deferredDeletions === 1 ? "" : "s"} pending — run "Sync now" to review`
			);
		if (r?.errors.length) parts.push(`${r.errors.length} errors`);
		return parts.length > 0 ? `S3 Sync: ${parts.join(", ")}` : "S3 Sync: up to date";
	}

	/**
	 * Forget the locally cached sync manifest after user confirmation.
	 *
	 * The cached manifest is this device's memory of what it has synced. When it
	 * gets out of step with the actual disk state (interrupted syncs, restored
	 * backups, Android storage cleanups), the next sync misreads missing files
	 * as local deletions and tombstones them on S3. Resetting the cache makes
	 * the next sync rebuild its view from S3 + disk: missing files become plain
	 * downloads, local-only files become uploads — nothing becomes a deletion.
	 */
	private doResetSyncState() {
		new ConfirmResetModal(this.app, async () => {
			if (this.syncing) {
				new Notice("S3 Sync: cannot reset while a sync is running");
				return;
			}
			const data = await this.loadFullData();
			delete data.localManifest;
			await this.saveData(data);
			new Notice(
				"S3 Sync: local sync state cleared. The next sync re-scans every file " +
					"(slower, one time) and will not delete anything on S3."
			);
		}).open();
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

class ConfirmResetModal extends Modal {
	private onConfirm: () => void;

	constructor(app: App, onConfirm: () => void) {
		super(app);
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Reset local sync state?" });
		contentEl.createEl("p", {
			text:
				"This makes the device forget which files it has already synced. " +
				"Use it when sync wrongly offers to delete files you never touched.",
		});
		contentEl.createEl("p", {
			text:
				"The next sync will re-scan everything: missing files are " +
				"re-downloaded, local-only files are re-uploaded, nothing is deleted. " +
				"If you have local edits not yet synced, they may be overwritten by " +
				"the S3 version — sync them first if possible.",
		});

		const row = contentEl.createDiv({ cls: "s3-sync-button-row" });
		const resetBtn = row.createEl("button", { text: "Reset", cls: "mod-warning" });
		resetBtn.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
		const cancelBtn = row.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
