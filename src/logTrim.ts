import * as fs from 'fs';

export const LOG_MAX_BYTES = 50 * 1024 * 1024;
/** Trimmed below the limit, so it isn't rewritten on every check. */
export const LOG_KEEP_BYTES = 40 * 1024 * 1024;

/** Cuts a log over `max` bytes down to its newest `keep` bytes (whole lines). True when it was cut. */
export function trimLog(file: string, max = LOG_MAX_BYTES, keep = LOG_KEEP_BYTES): boolean {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size <= max) return false;
  const buf = Buffer.alloc(keep);
  const fd = fs.openSync(file, 'r');
  let read: number;
  try { read = fs.readSync(fd, buf, 0, keep, size - keep); } finally { fs.closeSync(fd); }
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, buf.subarray(buf.indexOf(0x0a) + 1, read));
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return true;
}
