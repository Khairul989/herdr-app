// A checked, reproducible correction to the pinned backend's keyboard ownership.
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const originalHash = "f95213202d38bd416a56c009b42d4bbfc142a07b96f919ee187233aa5cb1b26a";
const before = 'function _(e,t){if(h(e)||o(e,a)||o(e,l)||g(e))return!0;let n=new Set,r=e.parentIndex;for(;typeof r==`number`&&!n.has(r);){n.add(r);let e=t.get(r);if(!e)return!1;if(o(e,l)||g(e))return!0;r=e.parentIndex}return!1}';
// Ownership is separate from the anchors used to measure the keyboard frame:
// a full-height keyboard window must not expand occlusion over the entire app.
const after = 'function H(e){return /^(?:_?UIKeyboard|UIKB|UIInputSet|TUI)/.test(e.role??``)}' + before.replace('if(h(e)', 'if(H(e)||h(e)').replace('if(o(e,l)', 'if(H(e)||o(e,l)');

export function keyboardPatch(source, expectedHash = originalHash) {
  const original = source.includes(after) ? source.replace(after, before) : source;
  if (createHash("sha256").update(original).digest("hex") !== expectedHash || !original.includes(before)) throw new Error("Keyboard ownership patch requires the original pinned agent-device 0.21.36 backend. Reinstall its tools before patching.");
  return original === source ? source.replace(before, after) : source;
}

export async function ensureKeyboardPatch(cli, io = fs) {
  const file = join(dirname(dirname(cli)), "dist/src/tap-keyboard-occlusion.js");
  const source = await io.readFile(file, "utf8"), patched = keyboardPatch(source);
  if (patched === source) return false;
  const temporary = `${file}.herdr-next-${process.pid}-${randomUUID()}`;
  await io.writeFile(`${file}.herdr-original`, source);
  try {
    await io.writeFile(temporary, patched);
    await io.rename(temporary, file);
  } finally { await io.unlink(temporary).catch(() => {}); }
  return true;
}
