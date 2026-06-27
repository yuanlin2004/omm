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

// 1. Single-root tree round-trips.
{
  const md = `---
mindmap-layout: left-right
---

- Root
  - Child A
    - Grandchild
  - Child B
`;
  const doc = m.parseMarkdown(md, "fallback", "top-down");
  check("layout from front-matter", doc.layout === "left-right");
  check("single root not synthetic", doc.syntheticRoot === false);
  check("root text", doc.root.text === "Root");
  check("root has 2 children", doc.root.children.length === 2);
  check("nested grandchild", doc.root.children[0].children[0].text === "Grandchild");

  const out = m.serializeMarkdown(doc, md);
  const reparsed = m.parseMarkdown(out, "fallback", "top-down");
  check("round-trip preserves structure", reparsed.root.children[0].children[0].text === "Grandchild");
  check("round-trip preserves layout", reparsed.layout === "left-right");
}

// 2. Multiple top-level bullets → synthetic root named after file.
{
  const md = `- One\n- Two\n  - Two-A\n`;
  const doc = m.parseMarkdown(md, "MyFile", "top-down");
  check("multi-top synthetic", doc.syntheticRoot === true);
  check("synthetic root uses fallback name", doc.root.text === "MyFile");
  check("synthetic root has 2 children", doc.root.children.length === 2);
  check("default layout applied", doc.layout === "top-down");

  // Serializing a synthetic root writes children at top level (no wrapper bullet).
  const out = m.serializeMarkdown(doc);
  const reparsed = m.parseMarkdown(out, "MyFile", "top-down");
  check("synthetic round-trip stays synthetic", reparsed.syntheticRoot === true);
  check("synthetic round-trip keeps 2 tops", reparsed.root.children.length === 2);
}

// 3. Tab indentation and mixed bullet markers.
{
  const md = `- Root\n\t- Tabbed child\n\t* Star child\n`;
  const doc = m.parseMarkdown(md, "f", "top-down");
  check("tab indent nests", doc.root.children.length === 2);
  check("star marker parsed", doc.root.children[1].text === "Star child");
}

// 4. Unknown front-matter keys are preserved.
{
  const md = `---\ntitle: Hello\nmindmap-layout: top-down\n---\n\n- A\n`;
  const doc = m.parseMarkdown(md, "f", "top-down");
  const out = m.serializeMarkdown(doc, md);
  check("preserves unknown front-matter key", out.includes("title: Hello"));
  check("emits layout once", (out.match(/mindmap-layout:/g) || []).length === 1);
}

// 5. Programmatic edits (add child / sibling, then an empty new node) round-trip.
{
  const doc = m.parseMarkdown(`- Root\n  - A\n`, "f", "top-down");
  const root = doc.root;
  // Simulate "add child" to A and "add sibling" to A.
  const a = root.children[0];
  a.children.push(m.newNode("A-child"));
  root.children.push(m.newNode("B"));
  // Simulate a freshly created, still-empty node.
  root.children.push(m.newNode(""));

  const out = m.serializeMarkdown(doc);
  const reparsed = m.parseMarkdown(out, "f", "top-down");
  check("added child persists", reparsed.root.children[0].children[0].text === "A-child");
  check("added sibling persists", reparsed.root.children[1].text === "B");
  check("empty node round-trips as empty", reparsed.root.children[2].text === "");
  check("child count after edits", reparsed.root.children.length === 3);
}

// 6. Multi-line node text encodes as <br> and round-trips to newlines.
{
  const doc = m.parseMarkdown(`- Root\n`, "f", "top-down");
  doc.root.children.push(m.newNode("line one\nline two\nline three"));
  const out = m.serializeMarkdown(doc);
  check("newlines encoded as <br>", out.includes("- line one<br>line two<br>line three"));
  check("no raw newline inside bullet", !/- line one\n\s*line two/.test(out));

  const reparsed = m.parseMarkdown(out, "f", "top-down");
  check("<br> decodes back to newlines", reparsed.root.children[0].text === "line one\nline two\nline three");
}

// 7. Existing <br> / <br/> in source Markdown is read as a line break.
{
  const doc = m.parseMarkdown(`- A<br/>B<br>C\n`, "f", "top-down");
  check("mixed <br/> and <br> decode", doc.root.text === "A\nB\nC");
}

rmSync(".tmp-model.mjs", { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
