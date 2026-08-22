import { App, Modal } from "obsidian";

import type { RunConfirmation } from "./runProfiles";

class MindmapRunConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly confirmation: RunConfirmation,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mindmap-confirm-modal");
    contentEl.createEl("h2", { text: this.confirmation.title });
    contentEl.createEl("p", { text: this.confirmation.message });

    const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelButton = buttonContainer.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.finish(false));

    const confirmButton = buttonContainer.createEl("button", { text: this.confirmation.confirmText });
    if (this.confirmation.confirmClass) {
      confirmButton.addClass(this.confirmation.confirmClass);
    }
    confirmButton.addEventListener("click", () => this.finish(true));
    confirmButton.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolve(false);
    }
  }

  private finish(confirmed: boolean): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolve(confirmed);
    this.close();
  }
}

export function confirmMindmapRun(app: App, confirmation: RunConfirmation): Promise<boolean> {
  return new Promise((resolve) => {
    new MindmapRunConfirmModal(app, confirmation, resolve).open();
  });
}
