export function localDayStarts(reference: number, count: number): number[] {
  const day = new Date(reference);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - count + 1);
  const starts: number[] = [];
  for (let i = 0; i < count; i++) {
    starts.push(day.getTime());
    day.setDate(day.getDate() + 1);
  }
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
