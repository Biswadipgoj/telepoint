// ─────────────────────────────────────────────────────────────────────────────
// Robust Supabase reads for large datasets.
//
// PostgREST (the API behind Supabase) returns at most ~1000 rows per request
// and rejects very long request URLs. A big retailer like MAMA TELECOM has
// 1000+ customers and many thousands of EMI rows, so the naive patterns:
//
//   supabase.from('emi_schedule').select('*').in('customer_id', thousandsOfIds)
//   supabase.from('emi_schedule').select('*')            // whole-table scan
//
// silently lose rows (row cap) or fail entirely (URL too long). That made the
// Live DB dashboard and the per-retailer summary count only a fraction of each
// customer's EMIs — looking like "only one EMI per customer is due".
//
// These helpers page through every row and chunk id-lists so nothing is lost.
// The caller's query MUST carry a stable, unique ordering, otherwise rows can
// repeat or skip across page boundaries.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 1000;
// Keep id-lists short enough that the encoded URL stays well under proxy limits
// (~150 UUIDs ≈ 5.5 KB of query string).
const ID_CHUNK = 150;

// Loose shape so a Supabase query builder (PostgrestSingleResponse<…>) is
// directly assignable — its `data` is a projected/partial row type and `error`
// is a PostgrestError, both structurally compatible with this.
type PageResult = { data: unknown[] | null; error: { message: string } | null };

/**
 * Page through a query that has no id-list filter (e.g. a whole-table scan or a
 * single-column filter like `.eq('retailer_id', id)`).
 */
export async function fetchAllPaged<T>(
  buildPage: (from: number, to: number) => PromiseLike<PageResult>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildPage(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * Fetch every row whose `idColumn` value is in `ids`, chunking the id-list to
 * stay under URL-length limits and paging each chunk to stay under the row cap.
 */
export async function fetchAllByIds<T>(
  ids: string[],
  buildPage: (chunk: string[], from: number, to: number) => PromiseLike<PageResult>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await buildPage(chunk, from, from + PAGE_SIZE - 1);
      if (error) throw new Error(error.message);
      const batch = (data ?? []) as T[];
      out.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
  }
  return out;
}
