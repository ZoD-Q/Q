/** Exact device-local calendar input, without a browser-owned calendar palette. */
export function localExecutionTime(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!match) return NaN;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(part => Number(part ?? 0));
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'));
  const date = new Date(year, month - 1, day, hour, minute, second, millisecond);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return NaN;
  return date.getTime();
}
