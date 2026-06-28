// D3-based SVG renderer for one or more mindmap trees. Each tree is laid out with its
// own style (top-down or left-right) and the trees are stacked top to bottom in a single,
// pan/zoomable canvas. Supports collapse/expand, multi-line rename, create/delete, undo,
// and opening links.

import { hierarchy, tree, HierarchyPointNode } from "d3-hierarchy";
import { select, Selection } from "d3-selection";
import { zoom, zoomIdentity, ZoomBehavior } from "d3-zoom";
import { linkVertical, linkHorizontal } from "d3-shape";
import {
  Layout,
  MindNode,
  MindTree,
  newNode,
  nextLayout,
  extractLinks,
  segmentText,
  displayLine,
  LinkInfo,
} from "./model";

const NODE_MIN_HEIGHT = 30;
const LINE_HEIGHT = 18;
const FONT_SIZE = 14;
const NARROW_CHAR_WIDTH = 8; // heuristic advance for Latin chars
const WIDE_CHAR_WIDTH = FONT_SIZE; // heuristic advance for full-width (CJK) chars
const NODE_PADDING_X = 14;
const NODE_PADDING_Y = 8;
const MIN_NODE_WIDTH = 40;
const LEVEL_GAP_TD = 45; // gap between level edges (top-down)
const LEVEL_GAP_LR = 70; // gap between level edges (left-right)
const SIBLING_GAP = 18; // gap between adjacent sibling edges
const TREE_GAP = 60; // vertical gap between stacked trees
const TREE_PAD = 10; // padding around each tree's bounding box
const BG_COLOR = "#ffffff";
const LINK_COLOR = "#2563eb";
const PALETTE = ["#4c6ef5", "#37b24d", "#f59f00", "#e8590c", "#ae3ec9", "#1098ad", "#e64980"];

function splitLines(text: string): string[] {
  return text.length ? text.split("\n") : [""];
}

/** True for full-width characters (CJK, Hangul, fullwidth forms) that need ~1em. */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extension B+
  );
}

function heuristicWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    w += isWideChar(ch.codePointAt(0) ?? 0) ? WIDE_CHAR_WIDTH : NARROW_CHAR_WIDTH;
  }
  return w;
}

// Prefer real font metrics (handles CJK and proportional fonts); fall back to the
// per-character heuristic if a canvas 2D context isn't available.
let measureCtx: CanvasRenderingContext2D | null | undefined;
function measureText(line: string): number {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement("canvas").getContext("2d");
      if (measureCtx) measureCtx.font = `${FONT_SIZE}px sans-serif`;
    } catch {
      measureCtx = null;
    }
  }
  if (measureCtx) return measureCtx.measureText(line).width;
  return heuristicWidth(line);
}

// Node size is based on the *displayed* text (links shown as their labels).
function nodeDims(text: string): { w: number; h: number; lines: string[] } {
  const lines = splitLines(text);
  const longest = lines.reduce((m, l) => Math.max(m, measureText(displayLine(l))), 0);
  const w = Math.max(MIN_NODE_WIDTH, longest + NODE_PADDING_X * 2);
  const h = Math.max(NODE_MIN_HEIGHT, lines.length * LINE_HEIGHT + NODE_PADDING_Y * 2);
  return { w, h, lines };
}

interface RendererOptions {
  /** Called after a mutation that must be persisted to Markdown (rename, add, delete, layout). */
  onChange: () => void;
  /** Called when the user requests undo (Cmd/Ctrl+Z). */
  onUndo: () => void;
  /** Called when the selection changes, so the UI can reflect the selected tree's layout. */
  onSelectionChange: () => void;
  /** Called to open the link(s) in a node; `x`/`y` are screen coords for a picker. */
  onOpenLinks: (links: LinkInfo[], x: number, y: number) => void;
  /**
   * Optional external text editor (used on mobile, where an inline SVG input misbehaves
   * with the on-screen keyboard). Resolves with the new text, or null if cancelled.
   */
  editText?: (initial: string) => Promise<string | null>;
}

const CLICK_DELAY = 250; // ms to wait for a possible double-click before opening a link

type GroupSel = Selection<SVGGElement, unknown, null, undefined>;

export class MindMapRenderer {
  private container: HTMLElement;
  private opts: RendererOptions;
  private svg!: Selection<SVGSVGElement, unknown, null, undefined>;
  private bgRect!: Selection<SVGRectElement, unknown, null, undefined>;
  private viewport!: Selection<SVGGElement, unknown, null, undefined>;
  private zoomBehavior!: ZoomBehavior<SVGSVGElement, unknown>;

  /** Shared reference to the document's trees (mutations here persist via onChange). */
  private trees: MindTree[] = [];
  private editing = false;
  /** Currently selected node (by reference). Cleared when new data is loaded. */
  private selected: MindNode | null = null;
  /** Per-node on-screen location, for placing the inline editor. Keyed by node id. */
  private placed = new Map<number, { group: GroupSel; x: number; y: number }>();
  /** Pending single-click action, deferred so a double-click can cancel it. */
  private clickTimer: number | null = null;

  constructor(container: HTMLElement, opts: RendererOptions) {
    this.container = container;
    this.opts = opts;
    this.build();
  }

  private build() {
    this.container.setAttribute("tabindex", "0");

    this.svg = select(this.container)
      .append("svg")
      .attr("class", "omm-svg")
      .attr("width", "100%")
      .attr("height", "100%");

    // White backdrop so PNG/PDF export is opaque.
    this.bgRect = this.svg.append("rect").attr("class", "omm-bg").attr("fill", BG_COLOR);
    this.viewport = this.svg.append("g").attr("class", "omm-viewport");

    // Clicking/tapping/panning the empty background deselects (and hides the toggle).
    // Use pointerdown so it works for both mouse and touch (d3-zoom can suppress click).
    this.svg.on("pointerdown", (event: PointerEvent) => {
      if (!(event.target as Element).closest(".omm-node")) {
        this.clearClickTimer();
        this.setSelected(null);
        this.highlightSelection();
      }
    });

    this.zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .filter((event: any) => {
        // Allow wheel-zoom and background drag; ignore drags that start on a node.
        if (event.type === "wheel") return true;
        return !(event.target as Element).closest(".omm-node");
      })
      .on("zoom", (event: any) => {
        this.viewport.attr("transform", event.transform.toString());
      });
    this.svg.call(this.zoomBehavior as any);

    this.container.addEventListener("keydown", (e) => this.onKeyDown(e));
  }

  setData(trees: MindTree[]) {
    this.trees = trees;
    this.selected = null;
  }

  /** Toggle the layout of the selected tree (or the first tree if nothing is selected). */
  toggleSelectedLayout() {
    const t = this.selectedTree();
    if (!t) return;
    t.layout = nextLayout(t.layout);
    this.opts.onChange();
    this.render(true);
  }

  getSelectedLayout(): Layout | null {
    return this.selectedTree()?.layout ?? null;
  }

  hasSelection(): boolean {
    return this.selected !== null;
  }

  // Public node-operation entry points, so the toolbar can drive editing on devices
  // without a keyboard (mobile). They no-op when nothing is selected.
  addChildToSelected() {
    this.addChild();
  }
  addSiblingToSelected() {
    this.addSibling();
  }
  removeSelectedNode() {
    this.deleteSelected();
  }
  editSelectedNode() {
    if (this.selected && !this.editing) this.editNode(this.selected, false);
  }

  /** Expand every collapsed node across all trees (UI-only state, not persisted). */
  expandAll() {
    const walk = (n: MindNode) => {
      n.collapsed = false;
      n.children.forEach(walk);
    };
    this.trees.forEach((t) => walk(t.root));
    this.render(true);
  }

  getSVGElement(): SVGSVGElement {
    return this.svg.node() as SVGSVGElement;
  }

  focus() {
    this.container.focus();
  }

  // --- Rendering ---

  /** Render all trees. Pass `fitView` to recenter; structural edits keep the current view. */
  render(fitView = false) {
    this.clearClickTimer();
    this.viewport.selectAll("*").remove();
    this.placed.clear();

    let offsetY = 0;
    for (const mt of this.trees) {
      const treeG = this.viewport.append("g").attr("class", "omm-tree");
      const box = this.renderTree(mt, treeG);
      // Left-align each tree at x = 0 and stack it below the previous one.
      treeG.attr("transform", `translate(${-box.minX},${offsetY - box.minY})`);
      offsetY += box.maxY - box.minY + TREE_GAP;
    }

    this.highlightSelection();
    if (fitView) this.fit();
  }

  /** Lay out and draw a single tree into `treeG`; returns its local bounding box. */
  private renderTree(
    mt: MindTree,
    treeG: GroupSel
  ): { minX: number; minY: number; maxX: number; maxY: number } {
    const layout = mt.layout;
    const breadthExtent = (text: string) =>
      layout === "top-down" ? nodeDims(text).w : nodeDims(text).h;
    const depthExtent = (text: string) =>
      layout === "top-down" ? nodeDims(text).h : nodeDims(text).w;

    const h = hierarchy(mt.root, (d) => (d.collapsed ? null : d.children));
    // nodeSize is [1, 1] so `separation` returns pixels: pack each sibling pair by
    // their real sizes instead of spacing the whole tree by the single largest node.
    const rootPoint = tree<MindNode>()
      .nodeSize([1, 1])
      .separation((a, b) => {
        const gap = (breadthExtent(a.data.text) + breadthExtent(b.data.text)) / 2 + SIBLING_GAP;
        return a.parent === b.parent ? gap : gap + SIBLING_GAP;
      })(h);
    const nodes = rootPoint.descendants();
    const links = rootPoint.links();

    // Pack each level by the widest/tallest node actually at that depth.
    const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
    const extentAt: number[] = new Array(maxDepth + 1).fill(0);
    for (const n of nodes) {
      extentAt[n.depth] = Math.max(extentAt[n.depth], depthExtent(n.data.text));
    }
    const levelGap = layout === "top-down" ? LEVEL_GAP_TD : LEVEL_GAP_LR;
    const levelOffset: number[] = new Array(maxDepth + 1).fill(0);
    for (let d = 1; d <= maxDepth; d++) {
      levelOffset[d] = levelOffset[d - 1] + extentAt[d - 1] / 2 + levelGap + extentAt[d] / 2;
    }

    // `d.x` is the breadth (sibling) position; depth comes from levelOffset.
    const px = (d: HierarchyPointNode<MindNode>) =>
      layout === "top-down" ? d.x : levelOffset[d.depth];
    const py = (d: HierarchyPointNode<MindNode>) =>
      layout === "top-down" ? levelOffset[d.depth] : d.x;

    // Analytic bounding box (independent of DOM layout / visibility).
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const d of nodes) {
      const { w, h: nh } = nodeDims(d.data.text);
      const cx = px(d);
      const cy = py(d);
      minX = Math.min(minX, cx - w / 2);
      maxX = Math.max(maxX, cx + w / 2);
      minY = Math.min(minY, cy - nh / 2);
      maxY = Math.max(maxY, cy + nh / 2);
    }
    minX -= TREE_PAD;
    minY -= TREE_PAD;
    maxX += TREE_PAD;
    maxY += TREE_PAD;

    const linkGen =
      layout === "top-down"
        ? linkVertical<any, HierarchyPointNode<MindNode>>()
            .x((d) => px(d))
            .y((d) => py(d))
        : linkHorizontal<any, HierarchyPointNode<MindNode>>()
            .x((d) => px(d))
            .y((d) => py(d));

    treeG
      .append("g")
      .attr("class", "omm-links")
      .selectAll("path")
      .data(links)
      .join("path")
      .attr("class", "omm-link")
      .attr("fill", "none")
      .attr("stroke", "#b0b8c4")
      .attr("stroke-width", 1.5)
      .attr("d", (d) => linkGen(d as any) as string);

    const nodeG = treeG
      .append("g")
      .attr("class", "omm-nodes")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("class", "omm-node")
      .attr("transform", (d) => `translate(${px(d)},${py(d)})`)
      .style("cursor", "pointer");

    nodeG.each((d, i, groups) => {
      const g = select(groups[i] as SVGGElement);
      this.placed.set(d.data.id, { group: treeG, x: px(d), y: py(d) });
      this.drawNode(g, d);
    });

    return { minX, minY, maxX, maxY };
  }

  /** Draw the contents of a single node group and wire its interactions. */
  private drawNode(g: GroupSel, d: HierarchyPointNode<MindNode>) {
    const { w, h: nh, lines } = nodeDims(d.data.text);
    const color = PALETTE[d.depth % PALETTE.length];
    const hasChildren = d.data.children.length > 0;
    const isCollapsed = hasChildren && d.data.collapsed;

    // Collapsed nodes get a "stacked card" hint peeking out behind them.
    if (isCollapsed) {
      g.append("rect")
        .attr("class", "omm-node-stack")
        .attr("x", -w / 2 + 4)
        .attr("y", -nh / 2 + 4)
        .attr("width", w)
        .attr("height", nh)
        .attr("rx", 6)
        .attr("ry", 6)
        .attr("fill", "#ffffff")
        .attr("stroke", color)
        .attr("stroke-width", 2)
        .attr("opacity", 0.45);
    }

    g.append("rect")
      .attr("class", "omm-node-rect")
      .attr("x", -w / 2)
      .attr("y", -nh / 2)
      .attr("width", w)
      .attr("height", nh)
      .attr("rx", 6)
      .attr("ry", 6)
      .attr("fill", "#ffffff")
      .attr("stroke", color)
      .attr("stroke-width", 2);

    const text = g
      .append("text")
      .attr("class", "omm-node-text")
      .attr("text-anchor", "middle")
      .attr("font-family", "var(--font-interface, sans-serif)")
      .attr("font-size", "14px")
      .attr("fill", "#1f2733");

    const startDy = -((lines.length - 1) / 2) * LINE_HEIGHT;
    lines.forEach((line, idx) => {
      // Each line is centered as a chunk; the first segment carries x/dy and the
      // rest flow inline. Link segments are shown as labels, underlined.
      segmentText(line).forEach((seg, sidx) => {
        const tspan = text.append("tspan").attr("dominant-baseline", "central").text(seg.text);
        if (sidx === 0) {
          tspan.attr("x", 0).attr("dy", idx === 0 ? startDy : LINE_HEIGHT);
        }
        if (seg.link) {
          tspan.attr("fill", LINK_COLOR).attr("text-decoration", "underline");
        }
      });
    });

    // Collapse/expand affordance, shown only while the node is selected.
    if (hasChildren) {
      const toggleX = w / 2 + 10;
      const toggle = g.append("g").attr("class", "omm-toggle-group").style("display", "none");
      const onToggle = (event: Event) => {
        event.stopPropagation();
        d.data.collapsed = !d.data.collapsed;
        this.render();
      };
      // Enlarged transparent hit area for comfortable tapping on touch screens.
      toggle
        .append("circle")
        .attr("cx", toggleX)
        .attr("cy", 0)
        .attr("r", 14)
        .attr("fill", "transparent")
        .style("cursor", "pointer")
        .on("click", onToggle);
      toggle
        .append("circle")
        .attr("class", "omm-toggle")
        .attr("cx", toggleX)
        .attr("cy", 0)
        .attr("r", 7)
        .attr("fill", color)
        .style("pointer-events", "none");
      toggle
        .append("text")
        .attr("class", "omm-toggle-sign")
        .attr("x", toggleX)
        .attr("y", 0)
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "central")
        .attr("font-size", "12px")
        .attr("fill", "#ffffff")
        .style("pointer-events", "none")
        .text(d.data.collapsed ? "+" : "−");
    }

    g.on("click", (event: MouseEvent) => {
      event.stopPropagation();
      this.clearClickTimer();
      if (this.selected !== d.data) {
        // First click selects the node.
        this.setSelected(d.data);
        this.container.focus();
        this.highlightSelection();
        return;
      }
      // Already selected: a further click opens its link(s), deferred so that a
      // double-click (to edit) can cancel it first.
      const links = extractLinks(d.data.text);
      if (links.length === 0) return;
      const { clientX, clientY } = event;
      this.clickTimer = window.setTimeout(() => {
        this.clickTimer = null;
        this.opts.onOpenLinks(links, clientX, clientY);
      }, CLICK_DELAY);
    });

    g.on("dblclick", (event: MouseEvent) => {
      event.stopPropagation();
      this.clearClickTimer();
      this.setSelected(d.data);
      this.editNode(d.data, false);
    });
  }

  /** Update the selection ring and toggle visibility, without rebuilding the DOM. */
  private highlightSelection() {
    const nodes = this.viewport.selectAll<SVGGElement, HierarchyPointNode<MindNode>>(".omm-node");
    nodes
      .select(".omm-node-rect")
      .attr("stroke-width", (d) => (d.data === this.selected ? 4 : 2))
      .attr("fill", (d) => (d.data === this.selected ? "#eef2ff" : "#ffffff"));
    nodes
      .select(".omm-toggle-group")
      .style("display", (d) => (d.data === this.selected ? null : "none"));
  }

  private setSelected(node: MindNode | null) {
    this.selected = node;
    this.opts.onSelectionChange();
  }

  // --- Tree lookups ---

  private treeOf(node: MindNode): MindTree | null {
    const has = (n: MindNode): boolean => n === node || n.children.some(has);
    return this.trees.find((t) => has(t.root)) ?? null;
  }

  private selectedTree(): MindTree | null {
    if (this.selected) return this.treeOf(this.selected);
    return this.trees[0] ?? null;
  }

  private parentOf(node: MindNode): MindNode | null {
    const find = (n: MindNode): MindNode | null => {
      for (const c of n.children) {
        if (c === node) return n;
        const deeper = find(c);
        if (deeper) return deeper;
      }
      return null;
    };
    for (const t of this.trees) {
      const found = find(t.root);
      if (found) return found;
    }
    return null;
  }

  // --- Keyboard handling ---

  private onKeyDown(e: KeyboardEvent) {
    if (this.editing) return;

    // Undo works regardless of selection.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.stopPropagation();
      this.opts.onUndo();
      return;
    }

    if (!this.selected) return;
    switch (e.key) {
      case "Tab":
      case "Insert":
        e.preventDefault();
        e.stopPropagation();
        this.addChild();
        break;
      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        this.addSibling();
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        e.stopPropagation();
        this.deleteSelected();
        break;
      case "F2":
        e.preventDefault();
        e.stopPropagation();
        this.editNode(this.selected, false);
        break;
    }
  }

  private addChild() {
    const parent = this.selected;
    if (!parent) return;
    const child = newNode("");
    parent.children.push(child);
    parent.collapsed = false;
    this.setSelected(child);
    this.opts.onChange();
    this.render();
    this.editNode(child, true);
  }

  private addSibling() {
    const node = this.selected;
    if (!node) return;
    const parent = this.parentOf(node);
    if (parent) {
      const sibling = newNode("");
      parent.children.splice(parent.children.indexOf(node) + 1, 0, sibling);
      this.setSelected(sibling);
      this.opts.onChange();
      this.render();
      this.editNode(sibling, true);
      return;
    }
    // A sibling of a tree root becomes a new tree, inserted right after it.
    const owner = this.treeOf(node);
    const idx = this.trees.findIndex((t) => t.root === node);
    if (idx < 0) return;
    const newRoot = newNode("");
    this.trees.splice(idx + 1, 0, { root: newRoot, layout: owner?.layout ?? "left-right" });
    this.setSelected(newRoot);
    this.opts.onChange();
    this.render();
    this.editNode(newRoot, true);
  }

  private deleteSelected() {
    if (this.selected) this.removeNode(this.selected);
  }

  private removeNode(node: MindNode) {
    const parent = this.parentOf(node);
    if (parent) {
      parent.children.splice(parent.children.indexOf(node), 1);
      this.setSelected(parent);
      this.opts.onChange();
      this.render();
      return;
    }
    // Deleting a tree root removes the whole tree.
    const idx = this.trees.findIndex((t) => t.root === node);
    if (idx < 0) return;
    this.trees.splice(idx, 1);
    const fallback = this.trees[idx]?.root ?? this.trees[idx - 1]?.root ?? null;
    this.setSelected(fallback);
    this.opts.onChange();
    this.render();
  }

  // --- Inline text editing (multi-line) ---

  /** Open an inline textarea over a node. New empty nodes are discarded if left blank. */
  private editNode(node: MindNode, isNew: boolean) {
    if (this.editing) return;

    // Mobile: edit in a modal that floats above the keyboard, not inside the SVG.
    if (this.opts.editText) {
      this.editing = true;
      this.opts.editText(node.text).then((result) => {
        this.editing = false;
        this.finishEdit(node, isNew, result);
      });
      return;
    }

    const placed = this.placed.get(node.id);
    if (!placed) return;
    const { group, x, y } = placed;
    this.editing = true;

    const fo = group.append("foreignObject");
    const textarea = fo
      .append("xhtml:textarea" as any)
      .attr("class", "omm-edit-input")
      .property("value", node.text)
      .node() as HTMLTextAreaElement;

    // Size the editor to the *raw* content (the textarea shows raw Markdown, not
    // the rendered link labels), keeping it centered on the node.
    const resize = () => {
      const lines = splitLines(textarea.value);
      const longest = lines.reduce((m, l) => Math.max(m, measureText(l)), 0);
      const w = Math.max(longest + NODE_PADDING_X * 2, 140);
      const hh = Math.max(NODE_MIN_HEIGHT, lines.length * LINE_HEIGHT + NODE_PADDING_Y * 2);
      fo.attr("x", x - w / 2)
        .attr("y", y - hh / 2)
        .attr("width", w)
        .attr("height", hh);
    };
    resize();
    textarea.focus();
    textarea.select();

    const commit = (save: boolean) => {
      if (!this.editing) return;
      this.editing = false;
      const value = textarea.value.replace(/\r/g, "").replace(/[ \t]+$/gm, "").trim();
      fo.remove();
      if (isNew && (!save || !value)) {
        // Cancelled or empty brand-new node → discard it.
        this.removeNode(node);
        return;
      }
      if (save && value && value !== node.text) {
        node.text = value;
        this.opts.onChange();
      }
      this.render();
      this.container.focus();
    };

    textarea.addEventListener("input", resize);
    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        // Enter commits; Shift+Enter inserts a newline (default behavior).
        e.preventDefault();
        commit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        commit(false);
      }
    });
    textarea.addEventListener("blur", () => commit(true));
  }

  /** Apply (or discard) an edited value. `result` is null when the edit was cancelled. */
  private finishEdit(node: MindNode, isNew: boolean, result: string | null) {
    const value = result === null ? "" : result.replace(/\r/g, "").replace(/[ \t]+$/gm, "").trim();
    if (isNew && (result === null || !value)) {
      // Cancelled or empty brand-new node → discard it.
      this.removeNode(node);
      return;
    }
    if (result !== null && value && value !== node.text) {
      node.text = value;
      this.opts.onChange();
    }
    this.render();
    this.container.focus();
  }

  /** Fit all trees into the viewport with a small margin. */
  fit() {
    const node = this.svg.node();
    if (!node) return;
    const bounds = (this.viewport.node() as SVGGElement).getBBox();
    if (!bounds.width || !bounds.height) return;
    const fullWidth = node.clientWidth || 800;
    const fullHeight = node.clientHeight || 600;

    this.bgRect.attr("width", fullWidth).attr("height", fullHeight);

    const margin = 40;
    const scale = Math.min(
      4,
      (fullWidth - margin * 2) / bounds.width,
      (fullHeight - margin * 2) / bounds.height
    );
    const tx = fullWidth / 2 - scale * (bounds.x + bounds.width / 2);
    const ty = fullHeight / 2 - scale * (bounds.y + bounds.height / 2);
    const transform = zoomIdentity.translate(tx, ty).scale(scale);
    this.svg.call(this.zoomBehavior.transform as any, transform);
  }

  private clearClickTimer() {
    if (this.clickTimer !== null) {
      window.clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
  }

  destroy() {
    this.clearClickTimer();
    this.svg.remove();
  }
}
