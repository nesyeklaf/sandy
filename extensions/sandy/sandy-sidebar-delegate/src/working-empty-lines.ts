/** What Active says while every thread is working. */
export const WORKING_EMPTY_LINES = [
  "Everyone's busy. Go grab a coffee.",
  "All hands on deck. Go stretch your legs.",
  "Nothing needs you. Go touch grass.",
  "Everyone's working. Refill your water.",
  "Go grab a snack. They'll ping you.",
  "Heads down. We'll call you when we're done.",
  "All threads are cooking.",
  "Busy little bees. Nothing for you yet.",
  "Everyone's typing. Nobody needs you.",
  "The team is in the zone.",
  "Shh. Genius at work.",
  "Nothing needs you right now.",
  "All quiet on your end.",
  "Every thread is running. You're free.",
  "Your inbox is empty. Theirs isn't.",
  "Zero asks. Enjoy it while it lasts.",
  "Your agents are earning their tokens.",
  "Plants watered, agents busy, you're free.",
] as const;

let lastLine = -1;

/** Test isolation between independently mounted scenes. */
export function resetWorkingEmptyLineForTests() {
  lastLine = -1;
}

/**
 * One line per appearance of the scene, never the one it showed last time.
 * The caller draws once on mount, so the line holds while the scene is up.
 */
export function pickWorkingEmptyLine(random: () => number = Math.random): string {
  // Draw from every line but the last one, then step over it.
  const hasLast = lastLine !== -1;
  let next = Math.floor(random() * (WORKING_EMPTY_LINES.length - (hasLast ? 1 : 0)));
  if (hasLast && next >= lastLine) next += 1;
  lastLine = next;
  return WORKING_EMPTY_LINES[next]!;
}
