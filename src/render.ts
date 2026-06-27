// D3-based SVG renderer for a mindmap tree. Supports top-down and left-right layouts,
// pan/zoom, collapse/expand, multi-line rename, node create/delete, and undo.

import { hierarchy, tree, HierarchyPointNode } from "d3-hierarchy";
import { select, Selection } from "d3-selection";
import { zoom, zoomIdentity, ZoomBehavior } from "d3-zoom";
import { linkVertical, linkHorizontal } from "d3-shape";
import { Layout, MindNode, newNode } from "./model";

const NODE_MIN_HEIGHT = 30;
const LINE_HEIGHT = 18;
const CHAR_WIDTH = 8;
const NODE_PADDING_X = 14;
const NODE_PADDING_Y = 8;
const MIN_NODE_WIDTH = 40;
const LEVEL_GAP_TD = 60; // extra vertical gap between levels (top-down)
const LEVEL_GAP_LR = 60; // extra horizontal gap between levels (left-right)
const SIBLING_GAP = 16;
const BG_COLOR = "#ffffff";
const PALETTE = ["#4c6ef5", "#37b24d", "#f59f00", "#e8590c", "#ae3ec9", "#1098ad", "#e64980"];

function splitLines(text: string): string[] {
  return text.length ? text.split("\n") : [""];
}

function nodeDims(text: string): { w: number; h: number; lines: string[] } {
  const lines = splitLines(text);
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const w = Math.max(MIN_NODE_WIDTH, longest * CHAR_WIDTH + NODE_PADDING_X * 2);
  const h = Math.max(NODE_MIN_HEIGHT, lines.length * LINE_HEIGHT + NODE_PADDING_Y * 2);
  return { w, h, lines };
}

interface RendererOptions {
  /** Called after a mutation that must be persisted to Markdown (rename, add, delete). */
  onChange: () => void;
  /** Called when the user requests undo (Cmd/Ctrl+Z). */
  onUndo: () => void;
}

export class MindMapRenderer {
  private container: HTMLElement;
  private opts: RendererOptions;
  private svg!: Selection<SVGSVGElement, unknown, null, undefined>;
  private bgRect!: Selection<SVGRectElement, unknown, null, undefined>;
  private viewport!: Selection<SVGGElement, unknown, null, undefined>;
  private zoomBehavior!: ZoomBehavior<SVGSVGElement, unknown>;

  private root: MindNode | null = null;
  private layout: Layout = "top-down";
  private editing = false;
  /** Currently selected node (by reference). Cleared when new data is loaded. */
  private selected: MindNode | null = null;
  /** Last laid-out points, used to locate a node's on-screen position for editing. */
  private lastPoints: HierarchyPointNode<MindNode>[] = [];

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

    // Clicking/panning the empty background deselects (and hides the toggle).
    // Use mousedown rather than click: d3-zoom can suppress the background click.
    this.svg.on("mousedown", (event: MouseEvent) => {
      if (!(event.target as Element).closest(".omm-node")) {
        this.selected = null;
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

  setData(root: MindNode, layout: Layout) {
    this.root = root;
    this.layout = layout;
    this.selected = null;
  }

  setLayout(layout: Layout) {
    this.layout = layout;
    this.render(true);
  }

  /** Expand every collapsed node (UI-only state, not persisted). */
  expandAll() {
    if (!this.root) return;
    const walk = (n: MindNode) => {
      n.collapsed = false;
      n.children.forEach(walk);
    };
    walk(this.root);
    this.render(true);
  }

  getSVGElement(): SVGSVGElement {
    return this.svg.node() as SVGSVGElement;
  }

  focus() {
    this.container.focus();
  }

  // Axis mapping: in left-right layout, depth runs horizontally.
  private px(d: HierarchyPointNode<MindNode>): number {
    return this.layout === "top-down" ? d.x : d.y;
  }
  private py(d: HierarchyPointNode<MindNode>): number {
    return this.layout === "top-down" ? d.y : d.x;
  }

  /** Render the tree. Pass `fitView` to recenter; structural edits keep the current view. */
  render(fitView = false) {
    if (!this.root) return;
    this.viewport.selectAll("*").remove();

    const max = this.maxDims(this.root);

    const h = hierarchy(this.root, (d) => (d.collapsed ? null : d.children));
    const layoutFn = tree<MindNode>();
    if (this.layout === "top-down") {
      layoutFn.nodeSize([max.w + SIBLING_GAP, max.h + LEVEL_GAP_TD]);
    } else {
      layoutFn.nodeSize([max.h + SIBLING_GAP, max.w + LEVEL_GAP_LR]);
    }
    const rootPoint = layoutFn(h);
    const nodes = rootPoint.descendants();
    this.lastPoints = nodes;
    const links = rootPoint.links();

    const linkGen =
      this.layout === "top-down"
        ? linkVertical<any, HierarchyPointNode<MindNode>>()
            .x((d) => this.px(d))
            .y((d) => this.py(d))
        : linkHorizontal<any, HierarchyPointNode<MindNode>>()
            .x((d) => this.px(d))
            .y((d) => this.py(d));

    this.viewport
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

    const nodeG = this.viewport
      .append("g")
      .attr("class", "omm-nodes")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("class", "omm-node")
      .attr("transform", (d) => `translate(${this.px(d)},${this.py(d)})`)
      .style("cursor", "pointer");

    nodeG.each((d, i, groups) => {
      const g = select(groups[i] as SVGGElement);
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
        text
          .append("tspan")
          .attr("x", 0)
          .attr("dy", idx === 0 ? startDy : LINE_HEIGHT)
          .attr("dominant-baseline", "central")
          .text(line);
      });

      // Collapse/expand affordance, shown only while the node is selected.
      if (hasChildren) {
        const toggleX = w / 2 + 10;
        const toggle = g
          .append("g")
          .attr("class", "omm-toggle-group")
          .style("display", "none");
        toggle
          .append("circle")
          .attr("class", "omm-toggle")
          .attr("cx", toggleX)
          .attr("cy", 0)
          .attr("r", 7)
          .attr("fill", color)
          .on("click", (event: MouseEvent) => {
            event.stopPropagation();
            d.data.collapsed = !d.data.collapsed;
            this.render();
          });
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
        this.selected = d.data;
        this.container.focus();
        this.highlightSelection();
      });

      g.on("dblclick", (event: MouseEvent) => {
        event.stopPropagation();
        this.selected = d.data;
        this.editNode(d.data, false);
      });
    });

    this.highlightSelection();
    if (fitView) this.fit();
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

  private parentOf(node: MindNode): MindNode | null {
    const find = (n: MindNode): MindNode | null => {
      for (const c of n.children) {
        if (c === node) return n;
        const deeper = find(c);
        if (deeper) return deeper;
      }
      return null;
    };
    return this.root ? find(this.root) : null;
  }

  private addChild() {
    const parent = this.selected;
    if (!parent) return;
    const child = newNode("");
    parent.children.push(child);
    parent.collapsed = false;
    this.selected = child;
    this.opts.onChange();
    this.render();
    this.editNode(child, true);
  }

  private addSibling() {
    const node = this.selected;
    if (!node) return;
    const parent = this.parentOf(node);
    if (!parent) {
      // Root has no sibling; fall back to adding a child.
      this.addChild();
      return;
    }
    const sibling = newNode("");
    const idx = parent.children.indexOf(node);
    parent.children.splice(idx + 1, 0, sibling);
    this.selected = sibling;
    this.opts.onChange();
    this.render();
    this.editNode(sibling, true);
  }

  private deleteSelected() {
    if (this.selected) this.removeNode(this.selected);
  }

  private removeNode(node: MindNode) {
    const parent = this.parentOf(node);
    if (!parent) {
      // Refuse to delete the root.
      return;
    }
    parent.children.splice(parent.children.indexOf(node), 1);
    this.selected = parent;
    this.opts.onChange();
    this.render();
  }

  // --- Inline text editing (multi-line) ---

  /** Open an inline textarea over a node. New empty nodes are discarded if left blank. */
  private editNode(node: MindNode, isNew: boolean) {
    if (this.editing) return;
    const point = this.lastPoints.find((p) => p.data === node);
    if (!point) return;
    const x = this.px(point);
    const y = this.py(point);
    this.editing = true;

    const fo = this.viewport.append("foreignObject");
    const textarea = fo
      .append("xhtml:textarea" as any)
      .attr("class", "omm-edit-input")
      .property("value", node.text)
      .node() as HTMLTextAreaElement;

    // Size the editor to the content and keep it centered on the node.
    const resize = () => {
      const d = nodeDims(textarea.value);
      const w = Math.max(d.w, 140);
      const h = Math.max(d.h, NODE_MIN_HEIGHT);
      fo.attr("x", x - w / 2)
        .attr("y", y - h / 2)
        .attr("width", w)
        .attr("height", h);
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

  /** Fit the whole tree into the viewport with a small margin. */
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

  private maxDims(node: MindNode): { w: number; h: number } {
    const self = nodeDims(node.text);
    let w = self.w;
    let h = self.h;
    if (!node.collapsed) {
      for (const c of node.children) {
        const d = this.maxDims(c);
        w = Math.max(w, d.w);
        h = Math.max(h, d.h);
      }
    }
    return { w, h };
  }

  destroy() {
    this.svg.remove();
  }
}
