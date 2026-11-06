(() => {
  const FENCE = "[data-genui-fence]";
  const PLUGIN = "[data-sandy-plugin]";
  const COMPOSER = "#thread-detail-follow-up-composer";
  const state = { active: null, pluginIds: new Set() };

  const afterPaint = (callback) => {
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        callback(performance.now());
      };
      channel.port2.postMessage(null);
    });
  };

  const region = (element) => {
    if (element.closest("[data-testid=app-sidebar-body]")) return "host:sidebar";
    if (element.closest("[data-page-scroll-viewport]")) return "host:timeline";
    if (element.closest(COMPOSER)) return "host:composer";
    return "host:shell";
  };

  const ownerOf = (node) => {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element || !element.isConnected) return "host:detached";
    if (element.closest(FENCE)) return "genui";
    const plugin = element.closest(PLUGIN);
    if (plugin) return plugin.getAttribute("data-sandy-plugin");
    return region(element);
  };

  const cardsRendered = () => {
    let count = 0;
    for (const card of document.querySelectorAll(FENCE)) {
      if (card.getBoundingClientRect().height > 0 && card.getElementsByTagName("*").length > 3) count += 1;
    }
    return count;
  };

  const switchReady = (threadId) =>
    location.pathname.endsWith("/threads/" + threadId) &&
    document.querySelector('[data-timeline-row-id^="' + CSS.escape(threadId) + ':"]') !== null &&
    document.querySelector(COMPOSER) !== null;

  const fiberName = (fiber) => {
    const type = fiber.type;
    if (type === null || type === undefined) return null;
    if (typeof type === "string") return null;
    if (typeof type === "function") return type.displayName || type.name || "(anonymous)";
    if (typeof type === "object")
      return (
        type.displayName ||
        type.render?.displayName ||
        type.render?.name ||
        type.type?.displayName ||
        type.type?.name ||
        null
      );
    return null;
  };

  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  const CONTEXT_PROVIDER_TAG = 10;
  const HOST_COMPONENT_TAG = 5;

  const recordCommit = (root) => {
    const active = state.active;
    if (active === null || active.t0 === null) return;
    const totals = active.react;
    const commitOwners = {};
    let commitTotal = 0;
    const stack = [{ fiber: root.current, owner: "host", card: null, component: "(root)" }];
    while (stack.length > 0) {
      const { fiber, owner: parentOwner, card: parentCard, component: parentComponent } = stack.pop();
      let owner = parentOwner;
      let card = parentCard;
      let component = parentComponent;
      if (fiber.tag === CONTEXT_PROVIDER_TAG) {
        const value = fiber.memoizedProps?.value;
        if (typeof value === "string" && state.pluginIds.has(value)) owner = value;
      }
      if (fiber.tag === HOST_COMPONENT_TAG && fiber.memoizedProps && fiber.memoizedProps["data-genui-fence"] !== undefined) {
        card = "card";
        owner = "genui";
      }
      if (COMPONENT_TAGS.has(fiber.tag)) component = fiberName(fiber) ?? component;
      const alternate = fiber.alternate;
      const descend = alternate === null || fiber.child !== alternate.child;
      let childTime = 0;
      if (descend) {
        for (let child = fiber.child; child !== null; child = child.sibling) {
          childTime += child.actualDuration ?? 0;
          stack.push({ fiber: child, owner, card, component });
        }
      }
      const self = Math.max(0, (fiber.actualDuration ?? 0) - childTime);
      if (self <= 0) continue;
      const key = owner + "\u0000" + component;
      const entry = totals.get(key) ?? { owner, component, ms: 0, fibers: 0 };
      entry.ms += self;
      entry.fibers += 1;
      totals.set(key, entry);
      commitOwners[owner] = (commitOwners[owner] ?? 0) + self;
      commitTotal += self;
    }
    active.commits.push({ at: performance.now() - active.t0, renderMs: commitTotal, owners: commitOwners });
  };

  const installReactHook = () => {
    let nextId = 1;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject(renderer) {
        const id = nextId++;
        this.renderers.set(id, renderer);
        return id;
      },
      checkDCE() {},
      onScheduleFiberRoot() {},
      onCommitFiberRoot(_id, root) {
        try {
          recordCommit(root);
        } catch (error) {
          if (state.active) state.active.reactErrors.push(String(error).slice(0, 200));
        }
      },
      onPostCommitFiberRoot() {},
      onCommitFiberUnmount() {},
    };
  };

  const arm = ({ threadId, expectedCards, pluginIds, quietMs, timeoutMs }) => {
    state.pluginIds = new Set(pluginIds);
    const active = {
      threadId,
      expectedCards,
      t0: null,
      batches: [],
      collectorMs: null,
      collectorMountMs: null,
      cardsMs: null,
      cardsPaintMs: null,
      maxCards: 0,
      lastMutationAt: null,
      react: new Map(),
      commits: [],
      reactErrors: [],
      finished: false,
    };
    state.active = active;
    let resolveDone;
    active.done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const observer = new MutationObserver((records) => {
      if (active.t0 === null) return;
      const now = performance.now();
      const owners = {};
      for (const record of records) {
        const owner = ownerOf(record.target);
        owners[owner] = (owners[owner] ?? 0) + 1;
      }
      const batch = { at: now - active.t0, owners, paintedAt: null };
      active.batches.push(batch);
      active.lastMutationAt = now;
      afterPaint((paintedAt) => {
        batch.paintedAt = paintedAt - active.t0;
      });
      if (active.collectorMountMs === null && switchReady(threadId)) {
        active.collectorMountMs = now - active.t0;
        afterPaint((paintedAt) => {
          active.collectorMs = paintedAt - active.t0;
        });
      }
    });
    const onPointerDown = (event) => {
      if (active.t0 !== null) return;
      active.t0 = event.timeStamp;
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      requestAnimationFrame(tick);
    };
    const finish = () => {
      if (active.finished) return;
      active.finished = true;
      observer.disconnect();
      removeEventListener("pointerdown", onPointerDown, true);
      resolveDone();
    };
    const tick = (frameAt) => {
      if (active.finished) return;
      const now = performance.now();
      const cards = cardsRendered();
      active.maxCards = Math.max(active.maxCards, cards);
      if (active.cardsMs === null && cards >= expectedCards && switchReady(threadId)) {
        active.cardsMs = now - active.t0;
        afterPaint((paintedAt) => {
          active.cardsPaintMs = paintedAt - active.t0;
        });
      }
      const quiet = active.lastMutationAt === null ? now - active.t0 : now - active.lastMutationAt;
      const settled =
        active.collectorMs !== null &&
        active.batches.every((batch) => batch.paintedAt !== null) &&
        (active.cardsPaintMs !== null || expectedCards === 0) &&
        quiet >= quietMs;
      if (settled || now - active.t0 >= timeoutMs) {
        active.timedOut = !settled;
        finish();
        return;
      }
      requestAnimationFrame(tick);
    };
    addEventListener("pointerdown", onPointerDown, true);
    return true;
  };

  const collect = async () => {
    const active = state.active;
    if (active === null) return null;
    await active.done;
    const pluginBatches = active.batches.filter((batch) => Object.keys(batch.owners).some((owner) => !owner.startsWith("host:")));
    const lastPainted = (batches) => batches.reduce((max, batch) => Math.max(max, batch.paintedAt ?? batch.at), 0) || null;
    const lastByOwner = {};
    for (const batch of active.batches)
      for (const owner of Object.keys(batch.owners))
        lastByOwner[owner] = Math.max(lastByOwner[owner] ?? 0, batch.paintedAt ?? batch.at);
    const result = {
      t0: active.t0,
      collectorMs: active.collectorMs,
      collectorMountMs: active.collectorMountMs,
      cardsMs: active.cardsMs,
      cardsPaintMs: active.cardsPaintMs,
      maxCards: active.maxCards,
      expectedCards: active.expectedCards,
      timedOut: active.timedOut,
      pluginDoneMs: lastPainted(pluginBatches),
      allDoneMs: lastPainted(active.batches),
      lastByOwner,
      batches: active.batches,
      react: [...active.react.values()],
      commits: active.commits,
      reactErrors: active.reactErrors.slice(0, 5),
      domNodes: document.getElementsByTagName("*").length,
      cardNodes: [...document.querySelectorAll(FENCE)].reduce((sum, card) => sum + card.getElementsByTagName("*").length, 0),
      cards: document.querySelectorAll(FENCE).length,
    };
    state.active = null;
    return result;
  };

  window.__ra = { arm, collect, installReactHook };
  if (window.__RA_REACT_HOOK__ === true) installReactHook();
})();
