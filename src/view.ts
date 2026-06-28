// Custom Obsidian view that renders a Markdown file as an interactive mindmap.

import { ItemView, TFile, WorkspaceLeaf, Notice, setIcon, Menu, Modal, Platform, App } from "obsidian";
import { LinkInfo, MindMapDoc, parseMarkdown, serializeMarkdown } from "./model";
import { MindMapRenderer } from "./render";
import { mindmapToPNG, mindmapToPDF } from "./export";
import type MindMapPlugin from "./main";

export const VIEW_TYPE_MINDMAP = "omm-mindmap-view";

interface MindMapViewState extends Record<string, unknown> {
  file: string;
}

export class MindMapView extends ItemView {
  private plugin: MindMapPlugin;
  private filePath: string | null = null;
  private doc: MindMapDoc | null = null;
  private renderer: MindMapRenderer | null = null;
  private canvasEl!: HTMLElement;
  private layoutLabelEl!: HTMLElement;
  /** Last content we wrote, to distinguish our own saves from external edits. */
  private lastWritten: string | null = null;
  /** Serialized snapshots of the document state before each change (for undo). */
  private undoStack: string[] = [];
  private static readonly MAX_UNDO = 100;

  constructor(leaf: WorkspaceLeaf, plugin: MindMapPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_MINDMAP;
  }

  getDisplayText(): string {
    if (!this.filePath) return "Mindmap";
    const base = this.filePath.split("/").pop() ?? this.filePath;
    return base.replace(/\.md$/, "");
  }

  getIcon(): string {
    return "git-fork";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("omm-view");
    this.buildToolbar();
    this.canvasEl = this.contentEl.createDiv({ cls: "omm-canvas" });
    this.renderer = new MindMapRenderer(this.canvasEl, {
      onChange: () => void this.save(),
      onUndo: () => void this.undo(),
      onSelectionChange: () => this.updateLayoutLabel(),
      onOpenLinks: (links, x, y) => this.openLinks(links, x, y),
      // On mobile, edit in a modal above the keyboard instead of an in-SVG input.
      editText: Platform.isMobile
        ? (initial) => new Promise((resolve) => new EditNodeModal(this.app, initial, resolve).open())
        : undefined,
    });

    // Reload when the file changes externally (not from our own save).
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.path === this.filePath) {
          void this.reloadIfExternallyChanged(file);
        }
      })
    );
  }

  async onClose(): Promise<void> {
    this.renderer?.destroy();
    this.renderer = null;
  }

  // --- State persistence (lets the leaf survive app reloads) ---

  async setState(state: MindMapViewState, result: any): Promise<void> {
    if (state?.file) {
      this.filePath = state.file;
      await this.loadFile();
    }
    await super.setState(state, result);
  }

  getState(): MindMapViewState {
    return { file: this.filePath ?? "" };
  }

  // --- Loading / saving ---

  private getFile(): TFile | null {
    if (!this.filePath) return null;
    const f = this.app.vault.getAbstractFileByPath(this.filePath);
    return f instanceof TFile ? f : null;
  }

  private async loadFile(): Promise<void> {
    const file = this.getFile();
    if (!file) {
      new Notice(`OMM: file not found: ${this.filePath}`);
      return;
    }
    const content = await this.app.vault.read(file);
    this.lastWritten = content;
    this.undoStack = []; // history is relative to the loaded content
    this.doc = parseMarkdown(content, this.plugin.settings.defaultLayout);
    this.renderer?.setData(this.doc.trees);
    this.renderer?.render(true);
    this.renderer?.focus();
    this.updateLayoutLabel();
  }

  private async reloadIfExternallyChanged(file: TFile): Promise<void> {
    const content = await this.app.vault.read(file);
    if (content === this.lastWritten) return; // our own write
    await this.loadFile();
  }

  private async save(): Promise<void> {
    const file = this.getFile();
    if (!file || !this.doc) return;
    const content = serializeMarkdown(this.doc, this.lastWritten ?? undefined);
    if (this.lastWritten !== null && this.lastWritten !== content) {
      this.undoStack.push(this.lastWritten);
      if (this.undoStack.length > MindMapView.MAX_UNDO) this.undoStack.shift();
    }
    this.lastWritten = content;
    await this.app.vault.modify(file, content);
  }

  /** Restore the previous document state from the undo stack. */
  private async undo(): Promise<void> {
    const snapshot = this.undoStack.pop();
    if (snapshot === undefined) {
      new Notice("OMM: nothing to undo");
      return;
    }
    const file = this.getFile();
    if (!file) return;
    this.doc = parseMarkdown(snapshot, this.plugin.settings.defaultLayout);
    this.lastWritten = snapshot; // marks the upcoming write as our own
    this.renderer?.setData(this.doc.trees);
    this.renderer?.render(false);
    this.renderer?.focus();
    this.updateLayoutLabel();
    await this.app.vault.modify(file, snapshot);
  }

  // --- Toolbar ---

  private buildToolbar(): void {
    const bar = this.contentEl.createDiv({ cls: "omm-toolbar" });

    this.layoutLabelEl = bar.createSpan({ cls: "omm-layout-label" });

    this.makeButton(bar, "git-fork", "Toggle layout of selected tree", () => {
      this.renderer?.toggleSelectedLayout();
      this.updateLayoutLabel();
    });

    this.toolbarSeparator(bar);

    // Node-editing buttons (work without a keyboard, e.g. on mobile).
    this.makeButton(bar, "list-plus", "Add child", () =>
      this.nodeOp(() => this.renderer?.addChildToSelected())
    );
    this.makeButton(bar, "plus", "Add sibling", () =>
      this.nodeOp(() => this.renderer?.addSiblingToSelected())
    );
    this.makeButton(bar, "pencil", "Edit node", () =>
      this.nodeOp(() => this.renderer?.editSelectedNode())
    );
    this.makeButton(bar, "trash-2", "Delete node", () =>
      this.nodeOp(() => this.renderer?.removeSelectedNode())
    );
    this.makeButton(bar, "undo-2", "Undo", () => void this.undo());

    this.toolbarSeparator(bar);

    this.makeButton(bar, "unfold-vertical", "Expand all", () => this.renderer?.expandAll());
    this.makeButton(bar, "maximize", "Fit to view", () => this.renderer?.fit());
    this.makeButton(bar, "image", "Export as PNG", () => void this.doExport("png"));
    this.makeButton(bar, "file-down", "Export as PDF", () => void this.doExport("pdf"));

    bar.createDiv({ cls: "omm-toolbar-spacer" });

    bar.createSpan({
      cls: "omm-hint",
      text: "Tab: child · Enter: sibling · Del: remove · F2: rename · Shift+Enter: newline · ⌘Z: undo",
    });

    this.makeButton(bar, "file-text", "Open as Markdown", () => void this.openAsMarkdown());
  }

  private makeButton(parent: HTMLElement, icon: string, tooltip: string, onClick: () => void): void {
    const btn = parent.createEl("button", { cls: "omm-toolbar-btn" });
    btn.setAttribute("aria-label", tooltip);
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
  }

  private toolbarSeparator(parent: HTMLElement): void {
    parent.createDiv({ cls: "omm-toolbar-sep" });
  }

  /** Run a node operation, prompting to select a node first if none is selected. */
  private nodeOp(fn: () => void): void {
    if (!this.renderer?.hasSelection()) {
      new Notice("OMM: tap a node to select it first");
      return;
    }
    fn();
  }

  private updateLayoutLabel(): void {
    if (!this.layoutLabelEl) return;
    const layout = this.renderer?.getSelectedLayout();
    this.layoutLabelEl.setText(layout === "top-down" ? "Top-down" : layout ? "Left-right" : "");
  }

  private async doExport(kind: "png" | "pdf"): Promise<void> {
    const svg = this.renderer?.getSVGElement();
    const file = this.getFile();
    if (!svg || !file) return;
    const base = this.getDisplayText();
    try {
      const data = kind === "png" ? await mindmapToPNG(svg) : await mindmapToPDF(svg);
      // Save next to the source note (works on desktop and mobile, unlike a download).
      const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
      const path = `${dir}${base}.${kind}`;
      await this.app.vault.adapter.writeBinary(path, data);
      new Notice(`OMM: exported to ${path}`);
    } catch (e) {
      new Notice(`OMM: export failed — ${(e as Error).message}`);
    }
  }

  // --- Link opening ---

  private openLinks(links: LinkInfo[], x: number, y: number): void {
    if (links.length === 0) return;
    if (links.length === 1) {
      this.openLink(links[0]);
      return;
    }
    // Multiple links: let the user pick which to open.
    const menu = new Menu();
    for (const link of links) {
      menu.addItem((item) =>
        item
          .setTitle(link.label || link.href)
          .setIcon(link.external ? "external-link" : "file")
          .onClick(() => this.openLink(link))
      );
    }
    menu.showAtPosition({ x, y });
  }

  private openLink(link: LinkInfo): void {
    if (link.external) {
      window.open(link.href, "_blank");
      return;
    }
    // Open the note in a new tab so the mindmap stays put.
    void this.app.workspace.openLinkText(link.href, this.filePath ?? "", true);
  }

  private async openAsMarkdown(): Promise<void> {
    const file = this.getFile();
    if (!file) return;
    await this.leaf.setViewState({
      type: "markdown",
      state: { file: file.path },
      active: true,
    });
  }
}

/** Mobile node-text editor: a modal that floats above the on-screen keyboard. */
class EditNodeModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private initial: string,
    private done: (value: string | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Edit node");
    const textarea = this.contentEl.createEl("textarea", { cls: "omm-modal-textarea" });
    textarea.value = this.initial;
    textarea.rows = 3;

    const buttons = this.contentEl.createDiv({ cls: "omm-modal-buttons" });
    const save = buttons.createEl("button", { text: "Save", cls: "mod-cta" });
    save.addEventListener("click", () => this.finish(textarea.value));
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.finish(null));

    // Focus after the modal settles so the keyboard opens reliably.
    window.setTimeout(() => {
      textarea.focus();
      textarea.select();
    }, 50);
  }

  private finish(value: string | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.done(value);
    this.close();
  }

  onClose(): void {
    // Dismissing the modal (tap outside / back) counts as cancel.
    if (!this.resolved) {
      this.resolved = true;
      this.done(null);
    }
    this.contentEl.empty();
  }
}
