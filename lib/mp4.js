// mp4 の中に記録された長さ（moov → mvhd）を読む。外部のライブラリは使わず、箱（box）の見出しだけを読んで進む。
// 保存した動画は X の動画サーバーから来た他人のデータなので、大きさの数字を信用しすぎない（範囲外なら null）。

import fs from 'node:fs';

function readBoxes(fd, start, end, want) {
  const head = Buffer.alloc(16);
  let pos = start;
  while (pos + 8 <= end) {
    if (fs.readSync(fd, head, 0, 16, pos) < 8) return null;
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let headLen = 8;
    if (size === 1) {
      size = Number(head.readBigUInt64BE(8));
      headLen = 16;
    } else if (size === 0) size = end - pos;
    if (size < headLen || pos + size > end) return null;
    if (type === want) return { start: pos + headLen, end: pos + size };
    pos += size;
  }
  return null;
}

// 長さ（ミリ秒）。読めなければ null
export function mp4DurationMs(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const moov = readBoxes(fd, 0, size, 'moov');
    if (!moov) return null;
    const mvhd = readBoxes(fd, moov.start, moov.end, 'mvhd');
    if (!mvhd || mvhd.end - mvhd.start < 32) return null;
    const b = Buffer.alloc(32);
    fs.readSync(fd, b, 0, 32, mvhd.start);
    const v1 = b[0] === 1;
    const timescale = v1 ? b.readUInt32BE(20) : b.readUInt32BE(12);
    const duration = v1 ? Number(b.readBigUInt64BE(24)) : b.readUInt32BE(16);
    if (!timescale || !Number.isFinite(duration)) return null;
    const ms = Math.round((duration / timescale) * 1000);
    return ms > 0 && ms < 24 * 60 * 60 * 1000 ? ms : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
