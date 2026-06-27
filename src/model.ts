// Data model: convert between Markdown (front-matter + nested bullet list) and a mindmap tree.

export type Layout = "top-down" | "left-right";

export interface MindNode {
  id: number;
  text: string;
  children: MindNode[];
  /** UI-only: whether this node's subtree is hidden. Not persisted to Markdown. */
  collapsed?: boolean;
}

export interface MindMapDoc {
  root: MindNode;
  layout: Layout;
  /** True when `root` is a synthetic container (the file had zero or many top-level bullets). */
  syntheticRoot: boolean;
}

export const DEFAULT_LAYOUT: Layout = "top-down";
const LAYOUTS: Layout[] = ["top-down", "left-right"];

let idCounter = 0;
function nextId(): number {
  return ++idCounter;
}

export function newNode(text: string): MindNode {
  return { id: nextId(), text, children: [] };
}

interface FrontMatter {
  layout?: Layout;
  raw: Record<string, string>;
}

/** Split a document into its front-matter block and the remaining body. */
function splitFrontMatter(content: string): { fm: FrontMatter; body: string } {
  const fm: FrontMatter = { raw: {} };
  // Front-matter must start at the very first line.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { fm, body: content };
  }
  const block = match[1];
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();
    fm.raw[key] = value;
    if (key === "mindmap-layout" && LAYOUTS.includes(value as Layout)) {
      fm.layout = value as Layout;
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
 * Parse Markdown content into a mindmap document.
 * @param rootTitle fallback title for a synthetic root (typically the file basename).
 */
export function parseMarkdown(content: string, rootTitle: string, defaultLayout: Layout): MindMapDoc {
  idCounter = 0;
  const { fm, body } = splitFrontMatter(content);
  const layout = fm.layout ?? defaultLayout;

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

  if (tops.length === 1) {
    return { root: tops[0], layout, syntheticRoot: false };
  }
  // Zero or many top-level bullets → wrap in a synthetic root.
  const root = newNode(rootTitle);
  root.children = tops;
  return { root, layout, syntheticRoot: true };
}

/** Serialize a mindmap document back to Markdown, preserving unknown front-matter keys. */
export function serializeMarkdown(doc: MindMapDoc, existing?: string): string {
  const preserved = existing ? splitFrontMatter(existing).fm.raw : {};
  const fmLines: string[] = [];
  for (const [k, v] of Object.entries(preserved)) {
    if (k === "mindmap-layout") continue; // re-emitted below with current value
    fmLines.push(`${k}: ${v}`);
  }
  fmLines.push(`mindmap-layout: ${doc.layout}`);

  const lines: string[] = ["---", ...fmLines, "---", ""];

  const writeNode = (node: MindNode, depth: number) => {
    lines.push(`${"  ".repeat(depth)}- ${encodeBreaks(node.text)}`);
    for (const child of node.children) writeNode(child, depth + 1);
  };

  if (doc.syntheticRoot) {
    for (const child of doc.root.children) writeNode(child, 0);
  } else {
    writeNode(doc.root, 0);
  }
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
