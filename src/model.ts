// Data model: convert between Markdown (front-matter + nested bullet list) and a mindmap tree.

export type Layout = "top-down" | "left-right";

export interface MindNode {
  id: number;
  text: string;
  children: MindNode[];
  /** UI-only: whether this node's subtree is hidden. Not persisted to Markdown. */
  collapsed?: boolean;
}

/** One mindmap tree: a top-level bullet (its root) plus its own layout style. */
export interface MindTree {
  root: MindNode;
  layout: Layout;
}

export interface MindMapDoc {
  /** One tree per first-level bullet, stacked top to bottom. */
  trees: MindTree[];
}

export const DEFAULT_LAYOUT: Layout = "left-right";
const LAYOUTS: Layout[] = ["top-down", "left-right"];

function isLayout(s: string): s is Layout {
  return (LAYOUTS as string[]).includes(s);
}

let idCounter = 0;
function nextId(): number {
  return ++idCounter;
}

export function newNode(text: string): MindNode {
  return { id: nextId(), text, children: [] };
}

interface FrontMatter {
  /** One layout per tree, in order. May be shorter than the number of trees. */
  layouts: Layout[];
  raw: Record<string, string>;
}

/** Strip surrounding single/double quotes that Obsidian's Properties editor may add. */
function unquote(s: string): string {
  return s.trim().replace(/^["']/, "").replace(/["']$/, "").trim();
}

/** Parse an inline or single-value layout list, e.g. `[top-down, "left-right"]` or `top-down`. */
function parseLayoutList(value: string): Layout[] {
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((s) => unquote(s))
    .filter((s) => s.length > 0)
    .filter(isLayout);
}

/** Split a document into its front-matter block and the remaining body. */
function splitFrontMatter(content: string): { fm: FrontMatter; body: string } {
  const fm: FrontMatter = { layouts: [], raw: {} };
  // Front-matter must start at the very first line.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { fm, body: content };
  }
  const block = match[1];
  let collectingLayouts = false;
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      collectingLayouts = false;
      const key = kv[1].trim();
      const value = kv[2].trim();
      fm.raw[key] = value;
      if (key === "mindmap-layout") {
        if (value) fm.layouts = parseLayoutList(value);
        else collectingLayouts = true; // block-style YAML list follows
      }
      continue;
    }
    // Block list item under `mindmap-layout:` (e.g. "  - top-down" or "  - \"top-down\"").
    if (collectingLayouts) {
      const item = line.match(/^\s*-\s*(.+?)\s*$/);
      if (item) {
        const value = unquote(item[1]);
        if (isLayout(value)) fm.layouts.push(value);
      }
    }
  }
  return { fm, body: content.slice(match[0].length) };
}

/** Number of indentation columns for a line's leading whitespace (tab = 4). */
function indentWidth(ws: string): number {
  let n = 0;
  for (const ch of ws) n += ch === "\t" ? 4 : 1;
  return n;
}

// Node text may span multiple lines. In Markdown we keep each node on a single
// bullet line and encode internal line breaks as <br>, decoding them back on parse.
function decodeBreaks(s: string): string {
  return s.replace(/<br\s*\/?>/gi, "\n");
}
function encodeBreaks(s: string): string {
  return s.replace(/\r?\n/g, "<br>");
}

/**
 * Parse Markdown content into a mindmap document. Each first-level bullet becomes a
 * tree; its layout comes from `mindmap-layout[i]`, falling back to `defaultLayout`.
 */
export function parseMarkdown(content: string, defaultLayout: Layout): MindMapDoc {
  idCounter = 0;
  const { fm, body } = splitFrontMatter(content);

  interface Parsed {
    node: MindNode;
    indent: number;
  }
  const tops: MindNode[] = [];
  const stack: Parsed[] = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const m = rawLine.match(/^(\s*)[-*+]\s+(.*)$/);
    if (!m) continue;
    const indent = indentWidth(m[1]);
    const node = newNode(decodeBreaks(m[2].trim()));

    // Pop deeper-or-equal levels so the stack top is this node's parent.
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    if (stack.length === 0) {
      tops.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ node, indent });
  }

  const trees: MindTree[] = tops.map((root, i) => ({
    root,
    layout: fm.layouts[i] ?? defaultLayout,
  }));
  return { trees };
}

/** Serialize a mindmap document back to Markdown, preserving unknown front-matter keys. */
export function serializeMarkdown(doc: MindMapDoc, existing?: string): string {
  const preserved = existing ? splitFrontMatter(existing).fm.raw : {};
  const fmLines: string[] = [];
  for (const [k, v] of Object.entries(preserved)) {
    if (k === "mindmap-layout") continue; // re-emitted below with current values
    fmLines.push(`${k}: ${v}`);
  }
  fmLines.push(`mindmap-layout: [${doc.trees.map((t) => t.layout).join(", ")}]`);

  const lines: string[] = ["---", ...fmLines, "---", ""];

  const writeNode = (node: MindNode, depth: number) => {
    lines.push(`${"  ".repeat(depth)}- ${encodeBreaks(node.text)}`);
    for (const child of node.children) writeNode(child, depth + 1);
  };

  for (const tree of doc.trees) writeNode(tree.root, 0);
  return lines.join("\n") + "\n";
}

export function nextLayout(layout: Layout): Layout {
  return layout === "top-down" ? "left-right" : "top-down";
}

export interface LinkInfo {
  /** Link target: a note path (optionally with #heading) or a URL. */
  href: string;
  /** Text to show in the link picker. */
  label: string;
  /** True for external URLs (http(s), mailto, …) rather than vault notes. */
  external: boolean;
}

/** Display label for a wikilink: the alias, else the note's basename (never the path). */
function wikiDisplay(target: string, alias?: string): string {
  if (alias && alias.trim()) return alias.trim();
  const hash = target.indexOf("#");
  const path = hash >= 0 ? target.slice(0, hash) : target;
  const heading = hash >= 0 ? target.slice(hash + 1) : "";
  const base = path.split("/").pop() ?? "";
  if (base && heading) return `${base} > ${heading}`;
  return base || heading || target;
}

export interface TextSegment {
  text: string;
  /** True when this segment is a link, shown as its display label. */
  link: boolean;
}

// Matches a wikilink (groups 1=target, 2=alias) or a Markdown link (3=label, 4=url).
const LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]*)\]\(([^)]+)\)/g;

/** Split a single line of node text into plain and link segments, links shown as labels. */
export function segmentText(line: string): TextSegment[] {
  const segs: TextSegment[] = [];
  const re = new RegExp(LINK_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) segs.push({ text: line.slice(last, m.index), link: false });
    const label =
      m[1] !== undefined ? wikiDisplay(m[1], m[2]) : m[3] && m[3].length ? m[3] : m[4];
    segs.push({ text: label, link: true });
    last = re.lastIndex;
  }
  if (last < line.length) segs.push({ text: line.slice(last), link: false });
  if (segs.length === 0) segs.push({ text: line, link: false });
  return segs;
}

/** A line with its links replaced by display labels (used for width measurement). */
export function displayLine(line: string): string {
  return segmentText(line)
    .map((s) => s.text)
    .join("");
}

/** Extract Obsidian wikilinks and Markdown links from a node's text, in order. */
export function extractLinks(text: string): LinkInfo[] {
  const links: LinkInfo[] = [];

  // [[target]], [[target|alias]], [[target#heading]]
  const wiki = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wiki.exec(text)) !== null) {
    const href = m[1].trim();
    links.push({ href, label: (m[2] ?? href).trim(), external: false });
  }

  // [label](target)
  const md = /\[([^\]]*)\]\(([^)]+)\)/g;
  while ((m = md.exec(text)) !== null) {
    const href = m[2].trim();
    const external = /^[a-z][a-z0-9+.-]*:\/\//i.test(href) || href.startsWith("mailto:");
    links.push({ href, label: (m[1] || href).trim(), external });
  }

  return links;
}
