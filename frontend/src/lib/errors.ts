export function formatError(err: unknown): string {
  if (err instanceof Error && err.message) {
    const raw = err.message;
    try {
      const parsed = JSON.parse(raw) as { detail?: unknown };
      if (typeof parsed.detail === "string") return parsed.detail;
      if (Array.isArray(parsed.detail)) {
        return parsed.detail
          .map((item) => (typeof item === "object" && item && "msg" in item ? String(item.msg) : String(item)))
          .join("; ");
      }
    } catch {
      return raw;
    }
    return raw;
  }
  return "Не удалось выполнить запрос";
}
