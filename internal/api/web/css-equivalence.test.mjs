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
const css = readFileSync(join(webDir, "styles", "app.css"), "utf8").replace(/\r\n/g, "\n");

test("external stylesheet preserves the extracted inline CSS bytes", () => {
  const digest = createHash("sha256").update(css).digest("hex");
  assert.equal(Buffer.byteLength(css), 167477);
  assert.equal(digest, "8dbdb52dec49cc1c94045cdb350d27c3490bd076b1ffaa3819dd8460117c6c47");
  assert.doesNotMatch(html, /<style(?:\s[^>]*)?>/i);
  assert.match(html, /<link rel="stylesheet" href="styles\/app\.css">/);
});
