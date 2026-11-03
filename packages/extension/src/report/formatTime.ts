const pad = (value: number) => String(value).padStart(2, '0');

/** Local date and time for reports and run lists, e.g. "2026-11-03 14:02". */
export function formatLocalTime(epochMs: number): string {
  const date = new Date(epochMs);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
