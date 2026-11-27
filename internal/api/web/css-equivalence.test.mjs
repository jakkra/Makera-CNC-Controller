// CSS extraction guard: app.css must remain byte-for-byte equivalent to the
// inline stylesheet that preceded this refactor. Update the baseline only when
// intentionally changing CSS declarations.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(webDir, "index.html"), "utf8");
// Git may check out CRLF on Windows and LF on Surface; declarations must match.
const cssFiles = ["base.css", "layout.css", "machine.css", "active-job.css", "jog.css", "camera.css", "files.css", "mobile.css"];
const css = cssFiles.map((name) => readFileSync(join(webDir, "styles", name), "utf8")).join("").replace(/\r\n/g, "\n");
const aggregateCSS = readFileSync(join(webDir, "styles", "app.css"), "utf8").replace(/\r\n/g, "\n");

test("external stylesheet preserves the extracted inline CSS bytes", () => {
  const digest = createHash("sha256").update(css).digest("hex");
  assert.equal(Buffer.byteLength(css), 203808);
  assert.equal(digest, "34789c80828ed0ce2968b1a7d297bd4749103a0a6e2e8b274d79c99e27ddd310");
  assert.equal(aggregateCSS, css, "styles/app.css must stay synchronized with the split stylesheets");
  assert.doesNotMatch(html, /<style(?:\s[^>]*)?>/i);
  for (const name of cssFiles) {
    assert.match(html, new RegExp(`<link rel="stylesheet" href="styles/${name}">`));
  }
});
