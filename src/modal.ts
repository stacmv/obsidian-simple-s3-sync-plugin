import { App, Modal } from "obsidian";
import type { S3Client } from "@aws-sdk/client-s3";
import type { S3SyncSettings } from "./settings";
import type { SyncManifest } from "./manifest";
import type { SyncAction, SyncPlan, SyncPlanEntry } from "./plan";
import type { SyncResult } from "./sync";
import { computeSyncPlan } from "./plan";
import { runSync, SyncCancelledError } from "./sync";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const ACTION_LABEL: Record<SyncAction, string> = {
	"download-new":    "new file",
	"download-update": "modified",
	"upload-new":      "new file",
	"upload-update":   "modified",
	"delete-local":    "deleted",
	"delete-remote":   "deleted",
	"conflict":        "conflict",
};

interface Section {
	heading: string;
	hint: string;
	actions: SyncAction[];
}

const SECTIONS: Section[] = [
	{
		heading: "Changes to pull from S3",
		hint: "(will be downloaded)",
		actions: ["download-new", "download-update"],
	},
	{
		heading: "Changes to push to S3",
		hint: "(will be uploaded)",
		actions: ["upload-new", "upload-update"],
	},
	{
		heading: "Deletions to apply locally",
		hint: "(removed on another device)",
		actions: ["delete-local"],
	},
	{
		heading: "Deletions to apply to S3",
		hint: "(removed on this device)",
		actions: ["delete-remote"],
	},
	{
		heading: "Conflicts",
		hint: "(both sides changed — a copy will be created)",
		actions: ["conflict"],
	},
];

// ---------------------------------------------------------------------------
// Step definitions
// ---------------------------------------------------------------------------

interface StepDef {
	label: string;
}

const STEPS: StepDef[] = [
	{ label: "Checking for changes" },
	{ label: "Preview changes" },
	{ label: "Acquiring lock" },
	{ label: "Pulling changes" },
	{ label: "Pushing changes" },
	{ label: "Finalizing" },
];

type ModalState = "planning" | "confirming" | "syncing" | "done" | "error" | "cancelled";

// ---------------------------------------------------------------------------
// SyncProgressModal
// ---------------------------------------------------------------------------

export class SyncProgressModal extends Modal {
	private client: S3Client;
	private settings: S3SyncSettings;
	private cachedManifest: SyncManifest;
	private saveCachedData: (data: { manifest: SyncManifest }) => Promise<void>;
	private onComplete: (result: SyncResult | null) => void;

	private state: ModalState = "planning";
	private currentStep = 0; // 0-based index into STEPS
	private stepDetail = "";
	private plan: SyncPlan | null = null;
	private result: SyncResult | null = null;
	private errorMessage = "";

	private abortController: AbortController | null = null;

	// DOM references for efficient updates
	private stepEls: HTMLElement[] = [];
	private detailEl: HTMLElement | null = null;
	private planContentEl: HTMLElement | null = null;
	private buttonRow: HTMLElement | null = null;

	constructor(
		app: App,
		client: S3Client,
		settings: S3SyncSettings,
		cachedManifest: SyncManifest,
		saveCachedData: (data: { manifest: SyncManifest }) => Promise<void>,
		onComplete: (result: SyncResult | null) => void
	) {
		super(app);
		this.client = client;
		this.settings = settings;
		this.cachedManifest = cachedManifest;
		this.saveCachedData = saveCachedData;
		this.onComplete = onComplete;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("s3-sync-progress-modal");

		contentEl.createEl("h2", { text: "S3 Sync" });

		// Step list
		const stepList = contentEl.createDiv({ cls: "s3-step-list" });
		for (let i = 0; i < STEPS.length; i++) {
			const el = stepList.createDiv({ cls: "s3-step" });
			const icon = el.createSpan({ cls: "s3-step-icon" });
			icon.setText("○");
			el.createSpan({ text: STEPS[i].label, cls: "s3-step-label" });
			this.stepEls.push(el);
		}

		// Detail line (sub-progress)
		this.detailEl = contentEl.createDiv({ cls: "s3-step-detail" });

		// Plan content area (shown during confirming)
		this.planContentEl = contentEl.createDiv({ cls: "s3-plan-content" });

		// Button row
		this.buttonRow = contentEl.createDiv({ cls: "s3-sync-button-row" });

		this.render();
		await this.startPlanning();
	}

	onClose() {
		// If still running, abort
		this.abortController?.abort();
		this.contentEl.empty();
	}

	// -----------------------------------------------------------------------
	// State machine
	// -----------------------------------------------------------------------

	private async startPlanning() {
		this.state = "planning";
		this.currentStep = 0;
		this.render();

		try {
			this.plan = await computeSyncPlan(
				this.app,
				this.client,
				this.settings,
				this.cachedManifest,
				(detail) => {
					this.stepDetail = detail;
					this.renderDetail();
				}
			);
			this.stepDetail = "";
			this.state = "confirming";
			this.currentStep = 1;
			this.render();
		} catch (e: any) {
			this.state = "error";
			this.errorMessage = e.message;
			this.render();
		}
	}

	private async startSync() {
		this.state = "syncing";
		this.currentStep = 2;
		this.render();

		this.abortController = new AbortController();

		try {
			this.result = await runSync(
				this.app,
				this.client,
				this.settings,
				{ manifest: this.cachedManifest },
				this.saveCachedData,
				(step, detail, result) => {
					this.currentStep = step - 1; // step 3–6 → index 2–5
					this.stepDetail = detail;
					this.result = result;
					this.render();
				},
				this.abortController.signal
			);

			this.state = "done";
			this.currentStep = STEPS.length; // all done
			this.stepDetail = "";
			this.render();
		} catch (e: any) {
			if (e instanceof SyncCancelledError) {
				this.state = "cancelled";
			} else {
				this.state = "error";
				this.errorMessage = e.message;
			}
			this.render();
		}
	}

	// -----------------------------------------------------------------------
	// Rendering
	// -----------------------------------------------------------------------

	private render() {
		this.renderSteps();
		this.renderDetail();
		this.renderPlanContent();
		this.renderButtons();
	}

	private renderSteps() {
		for (let i = 0; i < STEPS.length; i++) {
			const el = this.stepEls[i];
			if (!el) continue;

			const icon = el.querySelector(".s3-step-icon") as HTMLElement;

			el.removeClass("s3-step-done", "s3-step-active", "s3-step-pending");

			if (i < this.currentStep) {
				el.addClass("s3-step-done");
				icon.setText("✓");
			} else if (i === this.currentStep && this.state !== "done") {
				el.addClass("s3-step-active");
				icon.setText("◌");
			} else {
				el.addClass("s3-step-pending");
				icon.setText("○");
			}
		}

		// On error/cancelled, mark current step differently
		if (this.state === "error" || this.state === "cancelled") {
			const el = this.stepEls[this.currentStep];
			if (el) {
				const icon = el.querySelector(".s3-step-icon") as HTMLElement;
				el.removeClass("s3-step-active");
				el.addClass(this.state === "error" ? "s3-step-error" : "s3-step-cancelled");
				icon.setText(this.state === "error" ? "✗" : "—");
			}
		}
	}

	private renderDetail() {
		if (!this.detailEl) return;
		this.detailEl.empty();

		if ((this.state === "planning" || this.state === "syncing") && this.stepDetail) {
			this.detailEl.setText(this.stepDetail);
			if (this.result) {
				const counts = this.formatCounts(this.result);
				if (counts) {
					this.detailEl.createEl("br");
					this.detailEl.createSpan({ text: counts, cls: "s3-step-counts" });
				}
			}
		} else if (this.state === "error") {
			this.detailEl.setText(this.errorMessage);
			this.detailEl.addClass("s3-step-detail-error");
		} else if (this.state === "cancelled") {
			this.detailEl.setText("Sync was cancelled. Partial changes may have been applied.");
		} else if (this.state === "done" && this.result) {
			const counts = this.formatCounts(this.result);
			this.detailEl.setText(counts || "Everything is up to date.");
			this.detailEl.removeClass("s3-step-detail-error");
		} else {
			this.detailEl.removeClass("s3-step-detail-error");
		}
	}

	private renderPlanContent() {
		if (!this.planContentEl) return;
		this.planContentEl.empty();

		if (this.state !== "confirming" || !this.plan) return;

		if (this.plan.entries.length === 0) {
			this.planContentEl.createEl("p", {
				text: "Nothing to sync — everything is up to date.",
				cls: "s3-sync-uptodate",
			});
			return;
		}

		for (const section of SECTIONS) {
			const items = this.plan.entries.filter((e) =>
				section.actions.includes(e.action)
			);
			if (items.length === 0) continue;

			this.renderSection(this.planContentEl, section, items);
		}
	}

	private renderSection(
		container: HTMLElement,
		section: Section,
		items: SyncPlanEntry[]
	) {
		const wrap = container.createDiv({ cls: "s3-sync-section" });

		const header = wrap.createDiv({ cls: "s3-sync-section-header" });
		header.createSpan({ text: section.heading, cls: "s3-sync-section-title" });
		header.createSpan({ text: `  ${section.hint}`, cls: "s3-sync-section-hint" });

		const list = wrap.createEl("ul", { cls: "s3-sync-file-list" });
		for (const entry of items) {
			const li = list.createEl("li");
			li.createSpan({
				text: ACTION_LABEL[entry.action].padEnd(10),
				cls: `s3-sync-label s3-sync-label-${entry.action}`,
			});
			li.createSpan({ text: entry.path, cls: "s3-sync-path" });
		}
	}

	private renderButtons() {
		if (!this.buttonRow) return;
		this.buttonRow.empty();

		if (this.state === "confirming" && this.plan) {
			const hasChanges = this.plan.entries.length > 0;

			if (hasChanges) {
				const syncBtn = this.buttonRow.createEl("button", {
					text: "Sync",
					cls: "mod-cta",
				});
				syncBtn.addEventListener("click", () => this.startSync());
			}

			const cancelBtn = this.buttonRow.createEl("button", {
				text: hasChanges ? "Cancel" : "Close",
			});
			cancelBtn.addEventListener("click", () => {
				this.close();
				this.onComplete(null);
			});
		} else if (this.state === "planning" || this.state === "syncing") {
			const cancelBtn = this.buttonRow.createEl("button", {
				text: "Cancel",
			});
			cancelBtn.addEventListener("click", () => {
				this.abortController?.abort();
				if (this.state === "planning") {
					// Can't truly cancel computeSyncPlan, just close
					this.close();
					this.onComplete(null);
				}
				// For syncing state, the catch block will handle state transition
			});
		} else {
			// done, error, cancelled
			const closeBtn = this.buttonRow.createEl("button", {
				text: "Close",
				cls: this.state === "done" ? "mod-cta" : "",
			});
			closeBtn.addEventListener("click", () => {
				this.close();
				this.onComplete(this.result);
			});
		}
	}

	private formatCounts(r: SyncResult): string {
		const parts: string[] = [];
		if (r.pulled) parts.push(`${r.pulled} downloaded`);
		if (r.pushed) parts.push(`${r.pushed} uploaded`);
		if (r.conflicts) parts.push(`${r.conflicts} conflicts`);
		if (r.errors.length) parts.push(`${r.errors.length} errors`);
		return parts.join(", ");
	}
}
