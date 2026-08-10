/** "1 creature" / "3 creatures". Naive -s plural, which is all the UI needs. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
