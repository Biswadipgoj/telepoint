/**
 * Minimal, zero-dependency XLSX writer.
 *
 * Builds a real Office Open XML (.xlsx) workbook by hand: a ZIP archive of
 * XML parts. Uses STORE (no compression) so we avoid pulling in a deflate
 * lib — Excel/LibreOffice still open the file fine.
 *
 * Public API: `buildXlsx({ sheets })` returns a Buffer ready to stream back
 * as the body of an HTTP response.
 */

import { deflateRawSync } from 'zlib';

// ── XML helpers ────────────────────────────────────────────────────────────
function escapeXml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strip XML 1.0 control chars Excel will reject.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function colLetter(index0: number): string {
  // 0 → A, 25 → Z, 26 → AA, ...
  let n = index0;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

// ── Sheet definition ───────────────────────────────────────────────────────
export type XlsxCell = string | number | boolean | null | undefined;
export interface XlsxSheet {
  name: string;            // tab name
  header: string[];        // first row
  rows: XlsxCell[][];      // data rows; each row aligned with header
}

function sanitizeSheetName(raw: string): string {
  // Excel forbids these characters and limits names to 31 chars.
  return (raw || 'Sheet').replace(/[\\\/\?\*\[\]:]/g, '_').slice(0, 31) || 'Sheet';
}

function buildSheetXml(sheet: XlsxSheet): string {
  const rowsXml: string[] = [];
  const allRows: XlsxCell[][] = [sheet.header, ...sheet.rows];
  for (let r = 0; r < allRows.length; r += 1) {
    const row = allRows[r] ?? [];
    const rowNum = r + 1;
    const cells: string[] = [];
    for (let c = 0; c < row.length; c += 1) {
      const ref = `${colLetter(c)}${rowNum}`;
      const v = row[c];
      if (v === null || v === undefined || v === '') {
        // Blank string cell — emit an empty inline string so Excel reserves the column.
        cells.push(`<c r="${ref}" t="inlineStr"><is><t/></is></c>`);
        continue;
      }
      if (typeof v === 'number' && Number.isFinite(v)) {
        cells.push(`<c r="${ref}"><v>${v}</v></c>`);
        continue;
      }
      if (typeof v === 'boolean') {
        cells.push(`<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`);
        continue;
      }
      const text = escapeXml(v);
      cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`);
    }
    rowsXml.push(`<row r="${rowNum}">${cells.join('')}</row>`);
  }
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rowsXml.join('')}</sheetData>` +
    `</worksheet>`
  );
}

function buildWorkbookXml(sheetNames: string[]): string {
  const sheets = sheetNames
    .map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheets}</sheets>` +
    `</workbook>`
  );
}

function buildWorkbookRels(sheetCount: number): string {
  const rels = Array.from({ length: sheetCount }, (_, i) =>
    `<Relationship Id="rId${i + 1}"` +
    ` Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"` +
    ` Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`
  );
}

function buildRootRels(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1"` +
    ` Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"` +
    ` Target="xl/workbook.xml"/>` +
    `</Relationships>`
  );
}

function buildContentTypes(sheetCount: number): string {
  const overrides = Array.from({ length: sheetCount }, (_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml"` +
    ` ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml"` +
    ` ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    overrides +
    `</Types>`
  );
}

// ── CRC-32 (IEEE 802.3) ────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) {
    c = (CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── ZIP writer (DEFLATE for compactness) ───────────────────────────────────
interface ZipEntry {
  name: string;
  raw: Buffer;          // original bytes
  data: Buffer;         // bytes actually stored (compressed)
  crc: number;
  method: number;       // 0 = store, 8 = deflate
}

function makeEntry(name: string, content: string): ZipEntry {
  const raw = Buffer.from(content, 'utf8');
  const crc = crc32(raw);
  // Deflate gives ~5x compression on XML; fall back to STORE on the rare
  // case where compression bloats the data (very small files).
  const deflated = deflateRawSync(raw);
  if (deflated.length < raw.length) {
    return { name, raw, data: deflated, crc, method: 8 };
  }
  return { name, raw, data: raw, crc, method: 0 };
}

function dosTime(d: Date): { time: number; date: number } {
  const time =
    ((d.getHours() & 0x1F) << 11) |
    ((d.getMinutes() & 0x3F) << 5) |
    ((Math.floor(d.getSeconds() / 2)) & 0x1F);
  const date =
    (((d.getFullYear() - 1980) & 0x7F) << 9) |
    (((d.getMonth() + 1) & 0x0F) << 5) |
    (d.getDate() & 0x1F);
  return { time, date };
}

function assembleZip(entries: ZipEntry[]): Buffer {
  const now = new Date();
  const { time, date } = dosTime(now);
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  const offsets: number[] = [];
  let cursor = 0;

  for (const e of entries) {
    offsets.push(cursor);
    const nameBuf = Buffer.from(e.name, 'utf8');

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // general purpose flag
    local.writeUInt16LE(e.method, 8);     // compression method
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    localChunks.push(local, e.data);
    cursor += local.length + e.data.length;
  }

  const centralStart = cursor;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const nameBuf = Buffer.from(e.name, 'utf8');
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);       // central directory signature
    central.writeUInt16LE(20, 4);               // version made by
    central.writeUInt16LE(20, 6);               // version needed
    central.writeUInt16LE(0, 8);                // general purpose flag
    central.writeUInt16LE(e.method, 10);        // compression method
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);               // extra
    central.writeUInt16LE(0, 32);               // comment len
    central.writeUInt16LE(0, 34);               // disk start
    central.writeUInt16LE(0, 36);               // internal attrs
    central.writeUInt32LE(0, 38);               // external attrs
    central.writeUInt32LE(offsets[i], 42);
    nameBuf.copy(central, 46);
    centralChunks.push(central);
    cursor += central.length;
  }
  const centralSize = cursor - centralStart;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);   // 0-3: signature
  end.writeUInt16LE(0, 4);            // 4-5: disk number
  end.writeUInt16LE(0, 6);            // 6-7: disk where central directory starts
  end.writeUInt16LE(entries.length, 8);   // 8-9: entries on this disk
  end.writeUInt16LE(entries.length, 10);  // 10-11: total entries
  end.writeUInt32LE(centralSize, 12);     // 12-15: central directory size
  end.writeUInt32LE(centralStart, 16);    // 16-19: offset of central directory
  end.writeUInt16LE(0, 20);                // 20-21: comment length

  return Buffer.concat([...localChunks, ...centralChunks, end]);
}

// ── Public entry point ─────────────────────────────────────────────────────
export function buildXlsx(opts: { sheets: XlsxSheet[] }): Buffer {
  if (!opts.sheets || opts.sheets.length === 0) {
    throw new Error('buildXlsx: at least one sheet is required');
  }
  // De-duplicate / sanitize sheet names so Excel does not reject the workbook.
  const seen = new Set<string>();
  const sanitized = opts.sheets.map(s => {
    let base = sanitizeSheetName(s.name);
    let candidate = base;
    let n = 2;
    while (seen.has(candidate.toLowerCase())) {
      candidate = `${base.slice(0, 28)}_${n}`;
      n += 1;
    }
    seen.add(candidate.toLowerCase());
    return { ...s, name: candidate };
  });

  const entries: ZipEntry[] = [];
  entries.push(makeEntry('[Content_Types].xml', buildContentTypes(sanitized.length)));
  entries.push(makeEntry('_rels/.rels', buildRootRels()));
  entries.push(makeEntry('xl/workbook.xml', buildWorkbookXml(sanitized.map(s => s.name))));
  entries.push(makeEntry('xl/_rels/workbook.xml.rels', buildWorkbookRels(sanitized.length)));
  for (let i = 0; i < sanitized.length; i += 1) {
    entries.push(makeEntry(`xl/worksheets/sheet${i + 1}.xml`, buildSheetXml(sanitized[i])));
  }
  return assembleZip(entries);
}

export function xlsxHeaders(filename: string): Record<string, string> {
  return {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store, no-cache',
  };
}
