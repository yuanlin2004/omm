# OMM MindMap

An Obsidian plugin that renders any Markdown outline as an interactive mindmap, and turns a mindmap back into a clean Markdown bullet list.

## Features

- **Two layouts** — top-down and left-right, toggled from the toolbar. The choice is stored per file in front-matter (`mindmap-layout`).
- **View switching** — open a Markdown file as a mindmap, or jump back to the Markdown editor, without leaving the leaf.
- **Markdown is the source of truth** — the document is a nested bullet list plus a small front-matter block. Edits in either view stay in sync.
- **Interaction** — pan (drag), zoom (wheel), collapse/expand branches, select a node, and edit structure with the keyboard.
- **Multi-line nodes** — a node can hold several lines; line breaks are stored in Markdown as `<br>`.
- **Open links** — a node containing `[[wikilinks]]` or `[markdown](links)` opens the target on a follow-up click (first click selects, click again opens). Nodes with several links show a picker; external URLs open in the browser.
- **Undo** — `Cmd/Ctrl+Z` reverts the last change (rename, add, delete, layout toggle).
- **Export** — save the current mindmap as **PNG** or **PDF**.

### Keyboard

| Key | Action |
| --- | --- |
| `Tab` / `Insert` | Add child to the selected node |
| `Enter` | Add a sibling after the selected node |
| `Delete` / `Backspace` | Remove the selected node (and its subtree) |
| `F2` / double-click | Edit the selected node |
| `Shift+Enter` | Insert a line break while editing (`Enter` commits) |
| `Cmd/Ctrl+Z` | Undo the last change |

## Document format

````markdown
---
mindmap-layout: top-down
---

- Project
  - Research
    - Interviews
    - Surveys
  - Design
  - Build
````

- A single top-level bullet becomes the root node.
- Zero or many top-level bullets are wrapped under a synthetic root named after the file.
- Unknown front-matter keys are preserved on save.

## Usage

- Ribbon icon **Open as mindmap**, the command **"Open current file as mindmap"**, or the file's right-click menu.
- In the mindmap toolbar: toggle layout, fit to view, export PNG, export PDF, and **Open as Markdown**.

## Development

```bash
npm install
npm run dev      # watch build → main.js
npm run build    # typecheck + production bundle
node test-model.mjs   # parse/serialize round-trip tests
```

To try it in a vault, copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/obsidian-mindmap-omm/`, then enable the plugin in
Obsidian's Community Plugins settings.
