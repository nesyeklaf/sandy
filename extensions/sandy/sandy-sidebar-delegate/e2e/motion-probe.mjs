// Runs in the page (pass to page.evaluate). Clicks one shelf header and checks
// the FLIP invariant: on the frame the list motion starts, every row and shelf
// that existed before the click is drawn exactly where it was. A shelf that
// "goes up and down" without moving breaks it on that first frame.
// Self-contained so it can also be pasted into a live sandy page by hand.
export async function probeShelfToggle(label) {
  const root = document.querySelector("[data-sandy-sidebar-root]");
  const scroller = root.querySelector("[data-list-motion-scroller]");
  const section = [...root.querySelectorAll("section[aria-label]")].find(
    (node) => node.getAttribute("aria-label") === label,
  );
  if (!section) throw new Error(`No ${label} shelf`);
  const button = section.querySelector(":scope > div > button[aria-expanded]");
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  // List motion uses plain Web Animations; CSS spinners and transitions are ignored.
  const motions = () =>
    root.getAnimations({ subtree: true }).filter((animation) => animation.constructor === Animation);
  const settle = async () => {
    for (let guard = 0; guard < 120; guard++) {
      if (motions().every((animation) => animation.playState !== "running")) return;
      await nextFrame();
    }
    throw new Error("List motion did not settle");
  };
  const describe = (node) => {
    const labelled = node.getAttribute("aria-label");
    if (node.tagName === "SECTION") return `section "${labelled}"`;
    const link = node.querySelector("a[aria-label]");
    return `${node.tagName.toLowerCase()} "${link?.getAttribute("aria-label") ?? labelled ?? node.textContent.trim().slice(0, 40)}"`;
  };
  // Every list motion on the element and its ancestors, for failure reports.
  const motionChain = (node) => {
    const chain = [];
    for (let item = node; item && item !== scroller; item = item.parentElement) {
      for (const animation of item.getAnimations()) {
        if (animation.constructor !== Animation) continue;
        const transform = animation.effect.getKeyframes()[0]?.transform;
        chain.push(`${describe(item)} ${animation.playState} t=${Math.round(animation.currentTime)} ${transform}`);
      }
    }
    return chain;
  };
  const measure = () => {
    const origin = scroller.getBoundingClientRect();
    return new Map(
      [...scroller.querySelectorAll("section, li")]
        .filter((node) => node.getClientRects().length > 0)
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return [node, { top: rect.top - origin.top + scroller.scrollTop, left: rect.left - origin.left }];
        }),
    );
  };

  await settle();
  await nextFrame();
  const expanding = button.getAttribute("aria-expanded") === "false";
  let previous = measure();
  const seen = new Set(motions());
  const motionStarts = new Map();
  const scrollBefore = scroller.scrollTop;
  const jumps = [];
  let updates = 0;
  button.click();
  const started = performance.now();
  while (performance.now() - started < 400) {
    await nextFrame();
    const fresh = motions().filter((animation) => !seen.has(animation));
    for (const animation of fresh) {
      seen.add(animation);
      motionStarts.set(animation.effect.target, animation.effect.getKeyframes()[0]?.transform ?? null);
      // Hold new motion at its first keyframe so the read below is exact.
      animation.currentTime = 0;
    }
    const current = measure();
    if (fresh.length > 0) {
      updates++;
      // Later updates in one toggle start mid-flight; allow one frame of travel.
      const tolerance = updates === 1 ? 1 : 24;
      for (const [node, before] of previous) {
        const after = current.get(node);
        if (!after) continue;
        const dy = after.top - before.top;
        const dx = after.left - before.left;
        if (Math.abs(dy) > tolerance || Math.abs(dx) > tolerance)
          jumps.push({
            element: describe(node),
            dy: Math.round(dy),
            dx: Math.round(dx),
            update: updates,
            motion: motionStarts.get(node) ?? null,
            chain: motionChain(node),
          });
      }
    } else if (updates === 0) {
      // Layout changed with no motion queued yet: React has not committed. Keep
      // the pre-click positions as the reference.
      continue;
    }
    previous = current;
    if (updates > 0 && motions().every((animation) => animation.playState !== "running")) break;
  }
  await settle();
  return { label, expanding, updates, jumps, scroll: [scrollBefore, scroller.scrollTop] };
}
