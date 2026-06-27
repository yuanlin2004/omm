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
