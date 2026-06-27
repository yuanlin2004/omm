import esbuild from "esbuild";
import { pathToFileURL } from "url";
import { writeFileSync, rmSync } from "fs";

// Bundle model.ts to a temp CJS-free ESM file we can import.
await esbuild.build({
  entryPoints: ["src/model.ts"],
  bundle: true,
  format: "esm",
  outfile: ".tmp-model.mjs",
  logLevel: "error",
});
const m = await import(pathToFileURL(process.cwd() + "/.tmp-model.mjs").href);

let pass = 0,
  fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  ok  -", name); }
  else { fail++; console.log("  FAIL-", name); }
}

// 1. Single tree round-trips; layout comes from the front-matter list.
{
  const md = `---
mindmap-layout: [left-right]
---

- Root
  - Child A
    - Grandchild
  - Child B
`;
  const doc = m.parseMarkdown(md, "top-down");
  check("one tree", doc.trees.length === 1);
  check("tree layout from front-matter", doc.trees[0].layout === "left-right");
  check("root text", doc.trees[0].root.text === "Root");
  check("root has 2 children", doc.trees[0].root.children.length === 2);
  check("nested grandchild", doc.trees[0].root.children[0].children[0].text === "Grandchild");

  const out = m.serializeMarkdown(doc, md);
  const reparsed = m.parseMarkdown(out, "top-down");
  check("round-trip preserves structure", reparsed.trees[0].root.children[0].children[0].text === "Grandchild");
  check("round-trip preserves layout", reparsed.trees[0].layout === "left-right");
}

// 2. Each first-level bullet becomes its own tree (no synthetic file-name root).
{
  const md = `- One\n  - One-A\n- Two\n  - Two-A\n- Three\n`;
  const doc = m.parseMarkdown(md, "left-right");
  check("three trees", doc.trees.length === 3);
  check("first tree root is One", doc.trees[0].root.text === "One");
  check("second tree root is Two", doc.trees[1].root.text === "Two");
  check("tree keeps its children", doc.trees[0].root.children[0].text === "One-A");
  check("no file-name root", doc.trees.every((t) => t.root.text !== "f"));

  const out = m.serializeMarkdown(doc);
  const reparsed = m.parseMarkdown(out, "left-right");
  check("round-trip keeps 3 trees", reparsed.trees.length === 3);
}

// 3. Per-tree layout list; extra trees fall back to the default.
{
  const md = `---\nmindmap-layout: [top-down, left-right]\n---\n\n- A\n- B\n- C\n`;
  const doc = m.parseMarkdown(md, "left-right");
  check("tree 0 from list", doc.trees[0].layout === "top-down");
  check("tree 1 from list", doc.trees[1].layout === "left-right");
  check("tree 2 falls back to default (left-right)", doc.trees[2].layout === "left-right");

  // Serialization writes the full per-tree list.
  const out = m.serializeMarkdown(doc);
  check("serializes layout list", out.includes("mindmap-layout: [top-down, left-right, left-right]"));
  const reparsed = m.parseMarkdown(out, "left-right");
  check("layout list round-trips", reparsed.trees.map((t) => t.layout).join() === "top-down,left-right,left-right");
}

// 3b. A bare (non-list) layout value still works for a single tree.
{
  const doc = m.parseMarkdown(`---\nmindmap-layout: top-down\n---\n\n- A\n`, "left-right");
  check("bare single layout value", doc.trees[0].layout === "top-down");
}

// 4. Tab indentation, mixed markers, and preserved unknown front-matter keys.
{
  const doc = m.parseMarkdown(`- Root\n\t- Tabbed child\n\t* Star child\n`, "left-right");
  check("tab indent nests", doc.trees[0].root.children.length === 2);
  check("star marker parsed", doc.trees[0].root.children[1].text === "Star child");

  const md = `---\ntitle: Hello\nmindmap-layout: [top-down]\n---\n\n- A\n`;
  const out = m.serializeMarkdown(m.parseMarkdown(md, "left-right"), md);
  check("preserves unknown front-matter key", out.includes("title: Hello"));
  check("emits layout once", (out.match(/mindmap-layout:/g) || []).length === 1);
}

// 5. Programmatic edits (add child / sibling, an empty node) round-trip.
{
  const doc = m.parseMarkdown(`- Root\n  - A\n`, "left-right");
  const root = doc.trees[0].root;
  root.children[0].children.push(m.newNode("A-child"));
  root.children.push(m.newNode("B"));
  root.children.push(m.newNode("")); // freshly created, still empty

  const reparsed = m.parseMarkdown(m.serializeMarkdown(doc), "left-right");
  const r = reparsed.trees[0].root;
  check("added child persists", r.children[0].children[0].text === "A-child");
  check("added sibling persists", r.children[1].text === "B");
  check("empty node round-trips as empty", r.children[2].text === "");
  check("child count after edits", r.children.length === 3);
}

// 6. Multi-line node text encodes as <br> and round-trips to newlines.
{
  const doc = m.parseMarkdown(`- Root\n`, "left-right");
  doc.trees[0].root.children.push(m.newNode("line one\nline two\nline three"));
  const out = m.serializeMarkdown(doc);
  check("newlines encoded as <br>", out.includes("- line one<br>line two<br>line three"));
  check("no raw newline inside bullet", !/- line one\n\s*line two/.test(out));

  const reparsed = m.parseMarkdown(out, "left-right");
  check("<br> decodes back to newlines", reparsed.trees[0].root.children[0].text === "line one\nline two\nline three");
}

// 7. Existing <br> / <br/> in source Markdown is read as a line break.
{
  const doc = m.parseMarkdown(`- A<br/>B<br>C\n`, "left-right");
  check("mixed <br/> and <br> decode", doc.trees[0].root.text === "A\nB\nC");
}

// 8. Link extraction: wikilinks, aliases, headings, markdown + external links.
{
  const a = m.extractLinks("see [[Note A]] and [[Path/Note B|Alias]]");
  check("two wikilinks found", a.length === 2);
  check("wikilink href", a[0].href === "Note A");
  check("wikilink alias label", a[1].label === "Alias" && a[1].href === "Path/Note B");
  check("wikilinks are internal", a.every((l) => !l.external));

  const b = m.extractLinks("[[Topic#Section]]");
  check("wikilink keeps heading", b[0].href === "Topic#Section");

  const c = m.extractLinks("[docs](https://example.com) and [local](Notes/Foo.md)");
  check("markdown external link", c[0].external === true && c[0].href === "https://example.com");
  check("markdown internal link", c[1].external === false && c[1].href === "Notes/Foo.md");

  check("no links → empty array", m.extractLinks("plain text").length === 0);
}

// 9. Display labels: [[Note]] → Note, alias shown, path hidden, mixed segments.
{
  check("plain wikilink shows note name", m.displayLine("[[Note]]") === "Note");
  check("path is hidden, basename shown", m.displayLine("[[Folder/Sub/Note]]") === "Note");
  check("alias is shown instead of path", m.displayLine("[[Folder/Note|My Alias]]") === "My Alias");
  check("markdown link shows label", m.displayLine("[Docs](https://x.com)") === "Docs");

  const segs = m.segmentText("see [[A|Alias]] now");
  check("segments split plain/link/plain", segs.length === 3);
  check("first segment plain", segs[0].link === false && segs[0].text === "see ");
  check("middle segment is link label", segs[1].link === true && segs[1].text === "Alias");
  check("last segment plain", segs[2].link === false && segs[2].text === " now");

  check("no-link line is one plain segment", m.segmentText("hello").length === 1);
}

rmSync(".tmp-model.mjs", { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
