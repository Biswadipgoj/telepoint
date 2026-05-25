/**
 * Pure CSV builder. No xlsx. No external CSV library.
 *
 * RFC 4180 quoting + UTF-8 BOM so Excel on Windows opens the file with
 * the right encoding instead of mangling rupee signs.
 */

const BOM = '﻿';

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s === '') return '';
  // Quote when the value contains a delimiter, quote, CR, or LF — or
  // when it has leading/trailing whitespace that Excel would trim.
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

export interface CsvBuildOptions {
  /** Header row labels, in the same order as keys in each row object. */
  header: string[];
  /**
   * Mixed-row array: each entry is either a pre-built CSV-formatted string
   * (used for banner/separator rows that don't fit the column grid) or an
   * object whose values are looked up by `keys` (defaults to `header`).
   */
  rows: Array<Record<string, unknown> | string>;
  /** Optional key list used to project objects to columns (defaults to header). */
  keys?: string[];
}

export function buildCsv(opts: CsvBuildOptions): string {
  const out: string[] = [BOM + csvRow(opts.header)];
  const keys = opts.keys ?? opts.header;
  for (const row of opts.rows) {
    if (typeof row === 'string') {
      out.push(row);
      continue;
    }
    out.push(csvRow(keys.map(k => row[k])));
  }
  return out.join('\r\n');
}

/** Single helper for downloadable CSV responses. */
export function csvHeaders(filename: string): Record<string, string> {
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store, no-cache',
  };
}
