import { z } from "zod";

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10001).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().max(100).optional(),
});

export const explorePaginationSchema = paginationSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(15),
});

export function parsePagination(query, defaults = {}, schema = paginationSchema) {
  const parsed = schema.safeParse({
    page: query.page ?? defaults.page,
    limit: query.limit ?? defaults.limit,
    search: query.search,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const err = new Error(issue?.message || "Yanlış səhifələmə parametrləri");
    err.status = 400;
    err.code = "INVALID_PAGINATION";
    throw err;
  }

  const { page, limit, search } = parsed.data;
  if ((page - 1) * limit > 10000) throw Object.assign(new Error("Pagination offset too large"), { status: 400, code: "INVALID_PAGINATION" });
  return {
    page,
    limit,
    search,
    skip: (page - 1) * limit,
  };
}

export function isValidObjectId(id) {
  return /^[a-fA-F0-9]{24}$/.test(String(id || ""));
}

export function cursorFilter(cursor) {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!isValidObjectId(parsed.id) || typeof parsed.at !== "string" || !Number.isFinite(Date.parse(parsed.at))) throw new Error();
    const createdAt = new Date(parsed.at);
    return { $or: [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: parsed.id } }] };
  } catch { throw Object.assign(new Error("Invalid pagination cursor"), { status: 400, code: "INVALID_CURSOR" }); }
}
export function nextCursor(items, limit) {
  const last = items.at(-1);
  return items.length === limit && last?.createdAt ? Buffer.from(JSON.stringify({ id: String(last._id), at: new Date(last.createdAt).toISOString() })).toString("base64url") : null;
}
