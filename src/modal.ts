import { App, Modal } from "obsidian";
import type { SyncAction, SyncPlan, SyncPlanEntry } from "./plan";

// Git-style labels, matching `git status` conventions
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

export class SyncPlanModal extends Modal {
	private plan: SyncPlan;
	private onConfirm: () => void;

	constructor(app: App, plan: SyncPlan, onConfirm: () => void) {
		super(app);
		this.plan = plan;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("s3-sync-plan-modal");

		contentEl.createEl("h2", { text: "Sync Preview" });

		if (this.plan.entries.length === 0) {
			contentEl.createEl("p", {
				text: "Nothing to sync — everything is up to date.",
				cls: "s3-sync-uptodate",
			});
		} else {
			for (const section of SECTIONS) {
				const items = this.plan.entries.filter((e) =>
					section.actions.includes(e.action)
				);
				if (items.length === 0) continue;

				this.renderSection(contentEl, section, items);
			}
		}

		this.renderButtons(contentEl);
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

	private renderButtons(container: HTMLElement) {
		const row = container.createDiv({ cls: "s3-sync-button-row" });

		const hasChanges = this.plan.entries.length > 0;

		if (hasChanges) {
			const syncBtn = row.createEl("button", {
				text: "Sync",
				cls: "mod-cta",
			});
			syncBtn.addEventListener("click", () => {
				this.close();
				this.onConfirm();
			});
		}

		const cancelBtn = row.createEl("button", {
			text: hasChanges ? "Cancel" : "Close",
		});
		cancelBtn.addEventListener("click", () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
