import {
  Plugin,
  WorkspaceLeaf,
  TFile,
  Menu,
  PluginSettingTab,
  Setting,
  App,
  Notice,
} from "obsidian";
import { Layout, DEFAULT_LAYOUT } from "./model";
import { MindMapView, VIEW_TYPE_MINDMAP } from "./view";

interface MindMapSettings {
  defaultLayout: Layout;
}

const DEFAULT_SETTINGS: MindMapSettings = {
  defaultLayout: DEFAULT_LAYOUT,
};

export default class MindMapPlugin extends Plugin {
  settings: MindMapSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_MINDMAP, (leaf) => new MindMapView(leaf, this));

    this.addRibbonIcon("git-fork", "Open as mindmap", () => {
      const file = this.app.workspace.getActiveFile();
      if (file) void this.openAsMindmap(file);
      else new Notice("OMM: no active Markdown file");
    });

    this.addCommand({
      id: "open-as-mindmap",
      name: "Open current file as mindmap",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && file.extension === "md";
        if (ok && !checking) void this.openAsMindmap(file as TFile);
        return ok;
      },
    });

    // Right-click menu entry on Markdown files.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file) => {
        if (file instanceof TFile && file.extension === "md") {
          menu.addItem((item) =>
            item
              .setTitle("Open as mindmap")
              .setIcon("git-fork")
              .onClick(() => void this.openAsMindmap(file))
          );
        }
      })
    );

    this.addSettingTab(new MindMapSettingTab(this.app, this));
  }

  onunload(): void {
    // Leaves of our view type are detached automatically by Obsidian on unload.
  }

  private async openAsMindmap(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_MINDMAP,
      state: { file: file.path },
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class MindMapSettingTab extends PluginSettingTab {
  plugin: MindMapPlugin;

  constructor(app: App, plugin: MindMapPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Default layout")
      .setDesc("Layout for trees with no style listed in the `mindmap-layout` front-matter.")
      .addDropdown((dd) =>
        dd
          .addOption("top-down", "Top-down")
          .addOption("left-right", "Left-right")
          .setValue(this.plugin.settings.defaultLayout)
          .onChange(async (value) => {
            this.plugin.settings.defaultLayout = value as Layout;
            await this.plugin.saveSettings();
          })
      );
  }
}
