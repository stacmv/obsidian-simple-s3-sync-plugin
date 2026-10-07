import type { App } from "obsidian";
import type { S3Client } from "@aws-sdk/client-s3";
import type { S3SyncSettings } from "./settings";
import type { SyncManifest } from "./manifest";
import type { SyncResult } from "./sync";
import { computeSyncPlan } from "./plan";
import { runSync, SyncCancelledError } from "./sync";

export type BackgroundPhase = "planning" | "syncing" | "done" | "error" | "cancelled";

/**
 * Observable state of a background sync. `stepIndex` uses the progress
 * modal's step numbering: 0 = checking for changes, 2–5 = lock/pull/push/
 * finalize (step 1, the preview, never happens in the background).
 */
export interface BackgroundSnapshot {
	phase: BackgroundPhase;
	stepIndex: number;
	detail: string;
	result: SyncResult | null;
	errorMessage: string;
}

export type BackgroundListener = (snapshot: BackgroundSnapshot) => void;

export interface BackgroundSyncStorage {
	loadCachedManifest: () => Promise<SyncManifest>;
	saveCachedData: (data: { manifest: SyncManifest }) => Promise<void>;
}

const FINAL_PHASES: BackgroundPhase[] = ["done", "error", "cancelled"];

/**
 * One auto-sync run (no confirmation, deletions deferred) that the UI can
 * attach to while it is in flight: the progress modal subscribes to watch it
 * and may cancel it. Created synchronously so the plugin always has a handle
 * to attach to as soon as it marks itself busy.
 */
export class BackgroundSync {
	private readonly controller = new AbortController();
	private readonly listeners = new Set<BackgroundListener>();
	private state: BackgroundSnapshot = {
		phase: "planning",
		stepIndex: 0,
		detail: "connecting...",
		result: null,
		errorMessage: "",
	};

	constructor(
		private readonly app: App,
		private readonly client: S3Client,
		private readonly settings: S3SyncSettings,
		private readonly storage: BackgroundSyncStorage
	) {}

	get snapshot(): BackgroundSnapshot {
		return this.state;
	}

	get finished(): boolean {
		return FINAL_PHASES.includes(this.state.phase);
	}

	/** Registers a listener and replays the current state to it immediately. */
	subscribe(listener: BackgroundListener): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => {
			this.listeners.delete(listener);
		};
	}

	abort() {
		this.controller.abort();
	}

	/** Runs the sync to completion. Never throws: the outcome is the final snapshot. */
	async run(): Promise<BackgroundSnapshot> {
		const signal = this.controller.signal;
		try {
			const cachedManifest = await this.storage.loadCachedManifest();

			// Compute the plan first (mirrors the interactive modal). When there's
			// nothing to do we return before acquiring the lock — an auto-sync tick
			// on a quiet vault must not put `.sync-lock.json` on S3, which would
			// otherwise flash a spurious "Sync locked by <device>" at any peer that
			// happens to sync inside that window.
			//
			// Tradeoff: skipping runSync on empty plans also skips tombstone GC and
			// empty-folder cleanup on those ticks. That's fine — those run on the
			// next tick that has real work, matching how the modal behaves on
			// "Nothing to sync".
			const plan = await computeSyncPlan(
				this.app,
				this.client,
				this.settings,
				cachedManifest,
				(detail) => this.update({ detail }),
				signal
			);

			if (plan.entries.length === 0) {
				this.update({
					phase: "done",
					stepIndex: 6,
					detail: "",
					result: { pulled: 0, pushed: 0, conflicts: 0, deferredDeletions: 0, errors: [] },
				});
				return this.state;
			}

			this.update({ phase: "syncing", stepIndex: 2, detail: "" });
			const result = await runSync(
				this.app,
				this.client,
				this.settings,
				{ manifest: cachedManifest },
				this.storage.saveCachedData,
				(step, detail, partial) =>
					this.update({ stepIndex: step - 1, detail, result: partial }),
				signal,
				plan.hashCache,
				plan.remoteManifest,
				// Auto-sync must never delete anything: deletions are destructive
				// and only the manual sync modal shows the user what exactly goes.
				{ applyDeletions: false }
			);
			this.update({ phase: "done", stepIndex: 6, detail: "", result });
		} catch (e: any) {
			if (e instanceof SyncCancelledError) {
				this.update({ phase: "cancelled", detail: "" });
			} else {
				this.update({ phase: "error", detail: "", errorMessage: e?.message ?? String(e) });
			}
		}
		return this.state;
	}

	private update(patch: Partial<BackgroundSnapshot>) {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener(this.state);
	}
}
