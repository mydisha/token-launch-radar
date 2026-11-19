// Local checks of the files main.ts copies into /output, mirroring the gate's dashboard and screenshot rows.
// A failed check stops the program with the reason, so a bad entry never reaches the grader unnoticed.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const NETWORK_ADDRESS = /\bhttps?:\/\//i;

/** Every regular file under `dir`, as paths relative to it. Throws on anything that is not a plain file or folder. */
function walk(dir: string, root: string = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (name.startsWith('.')) throw new Error(`${relative(root, full)}: a directory may not start with a dot`);
      walk(full, root, out);
    } else if (info.isFile()) {
      out.push(relative(root, full));
    } else {
      throw new Error(`${relative(root, full)}: not a regular file`);
    }
  }
  return out;
}

/** The first problem with the dashboard folder, or null. */
export function dashboardIssue(dir: string): string | null {
  let files: string[];
  try {
    files = walk(dir);
  } catch (e) {
    return (e as Error).message;
  }
  if (!files.includes('index.html')) return 'dashboard/ has no index.html';
  if (!files.some((f) => f.endsWith('.css'))) return 'dashboard/ has no .css file';
  if (!files.some((f) => f.endsWith('.js'))) return 'dashboard/ has no .js file';
  if (files.length > 400) return `dashboard/ has ${files.length} files, at most 400`;
  let total = 0;
  let source = 0;
  for (const f of files) {
    const base = f.split('/').pop()!;
    if (!FILE_NAME.test(base)) return `${f}: file names use letters, digits and ._- only`;
    const bytes = readFileSync(join(dir, f));
    total += bytes.length;
    if (/\.(html|css|js|json|mjs|svg|md|txt)$/.test(f)) {
      source += bytes.length;
      if (/\.(html|css|js|mjs)$/.test(f) && NETWORK_ADDRESS.test(bytes.toString('utf8'))) return `${f}: names a network address`;
    }
  }
  if (total > 4 * 1024 * 1024) return `dashboard/ is ${total} bytes, at most 4 MiB`;
  if (source > 65_536) return `the dashboard's source is ${source} bytes, so the dossier would cut it at 65536`;
  return null;
}

/** Width and height of a PNG or JPEG, or null when the bytes are neither. */
export function imageSize(bytes: Buffer): { w: number; h: number } | null {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      const len = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: bytes.readUInt16BE(at + 5), w: bytes.readUInt16BE(at + 7) };
      }
      at += 2 + len;
    }
  }
  return null;
}

/** The first problem with the screenshots folder, or null. */
export function screenshotsIssue(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return 'screenshots/ is missing';
  }
  if (names.length < 3 || names.length > 4) return `screenshots/ holds ${names.length} images, the gate takes 3 or 4`;
  for (const name of names) {
    if (!FILE_NAME.test(name)) return `${name}: not a valid image name`;
    const bytes = readFileSync(join(dir, name));
    if (bytes.length > 524_288) return `${name} is ${bytes.length} bytes, at most 524288`;
    const size = imageSize(bytes);
    if (size === null) return `${name} is not a whole PNG or JPEG`;
    if (Math.max(size.w, size.h) > 1440) return `${name}: long side ${Math.max(size.w, size.h)} is over 1440`;
    if (Math.min(size.w, size.h) < 800) return `${name}: short side ${Math.min(size.w, size.h)} is under 800`;
  }
  return null;
}
