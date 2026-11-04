export function localDayStarts(reference: number, count: number): number[] {
  const ref = new Date(reference);
  const starts: number[] = [];
  // Build each midnight from calendar fields so a DST change at 00:00 cannot
  // carry a one-hour shift into every later day.
  for (let i = 0; i < count; i++) starts.push(new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - count + 1 + i).getTime());
  return starts;
}

export function localDayIndex(timestamp: number, starts: number[]): number {
  const value = new Date(timestamp);
  return starts.findIndex(start => {
    const day = new Date(start);
    return day.getFullYear() === value.getFullYear()
      && day.getMonth() === value.getMonth()
      && day.getDate() === value.getDate();
  });
}
