/** Minimal CSV reader for the PSP/bank feeds, which contain no quoted fields. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const header = lines.shift();
  if (!header) return [];
  const columns = header.split(",").map((c) => c.trim());
  return lines.map((line) => {
    const values = line.split(",");
    return Object.fromEntries(columns.map((c, i) => [c, (values[i] ?? "").trim()]));
  });
}
