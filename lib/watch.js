const fsp = require('fs/promises');
const { scanZstdFrames, decompressDshLog } = require('./platforms/dsh');

// ========= /api/watch business logic =========
// Byte-offset tail of a session log plus platform-aware line normalization.
// The SSE plumbing (headers, fs.watch, ping/cleanup timers) stays in the
// route; these two functions carry the state machines that need direct tests.

// Read new lines from a byte offset, returning { lines, newOffset }.
//
// Plain JSONL: only advance past the last complete line — a torn trailing
// line (the writer was mid-append when fs.watch fired) is retried on the next
// change event once its remaining bytes land.
//
// dsh zstd logs append whole zstd frames: decompress every complete new frame
// and leave a torn trailing frame for the next read (mirrors the JSONL rule).
async function readNewLines(filePath, byteOffset) {
  const stat = await fsp.stat(filePath);
  if (stat.size <= byteOffset) return { lines: [], newOffset: byteOffset };
  const buf = Buffer.alloc(stat.size - byteOffset);
  const fd = await fsp.open(filePath, 'r');
  try {
    await fd.read(buf, 0, buf.length, byteOffset);
  } finally {
    await fd.close();
  }
  if (filePath.endsWith('.zstd')) {
    const { frames } = scanZstdFrames(buf);
    const consumed = frames.length ? frames[frames.length - 1].end : 0;
    const text = decompressDshLog(buf.subarray(0, consumed));
    const lines = text.split('\n').filter((l) => l.trim());
    return { lines, newOffset: byteOffset + consumed };
  }
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline === -1) return { lines: [], newOffset: byteOffset };
  const text = buf.subarray(0, lastNewline + 1).toString('utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  return { lines, newOffset: byteOffset + lastNewline + 1 };
}

// Normalize raw log lines through the platform's watchParse adapter.
// Returns { messages, sessionMeta } — sessionMeta is the last session record
// seen (if any), messages the concatenated normalized fan-out.
function parseWatchLines(platform, lines) {
  const messages = [];
  let sessionMeta = null;
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = platform.watchParse(rec, line);
    if (!parsed) continue;
    if (parsed.session) sessionMeta = parsed.session;
    if (parsed.messages) messages.push(...parsed.messages);
  }
  return { messages, sessionMeta };
}

module.exports = {
  readNewLines,
  parseWatchLines,
};
