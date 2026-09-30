const MAX_SESSIONS = 64;
const MAX_CONTEXTS = 256;
const MAX_OBJECTS = 256;
// A hidden cross-site iframe runs in a renderer the browser deprioritizes, and
// on a busy machine it can take seconds to answer. The tree skips such a frame
// rather than holding every later command for the tab.
const CHILD_TREE_TIMEOUT = 1000;
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe", exclude: false }, { exclude: true }] };

export function createFrameTransport(api, tabId, changed) {
  const sessions = new Set([""]);
  const owners = new Map();
  const contexts = new Map();
  const objects = new Map();
  let counter = 2 ** 40;
  let disposed = false;
  let network = null;

  const raw = (sessionId, method, params = {}) => {
    if (disposed || !sessions.has(sessionId)) throw new Error("Browser frame detached");
    return api.debugger.sendCommand({ tabId, ...(sessionId && { sessionId }) }, method, params);
  };

  const prepare = async (sessionId) => {
    await raw(sessionId, "Page.enable");
    await raw(sessionId, "Runtime.enable");
    if (network) await raw(sessionId, "Network.enable", network);
    await raw(sessionId, "Target.setAutoAttach", AUTO_ATTACH);
  };

  const invalidate = (sessionId) => {
    for (const [key, entry] of contexts) if (entry.sessionId === sessionId) contexts.delete(key);
    for (const [key, entry] of objects) if (entry.sessionId === sessionId) objects.delete(key);
    for (const [key, owner] of owners) if (owner === sessionId) owners.delete(key);
    changed();
  };

  function event(source, method, params) {
    const sessionId = source.sessionId ?? "";
    if (disposed || source.tabId !== tabId || !sessions.has(sessionId)) return false;
    if (method === "Target.attachedToTarget") {
      if (params.targetInfo?.type !== "iframe" || typeof params.sessionId !== "string" || sessions.size >= MAX_SESSIONS) return false;
      sessions.add(params.sessionId);
      void prepare(params.sessionId).catch(() => { sessions.delete(params.sessionId); invalidate(params.sessionId); });
    } else if (method === "Target.detachedFromTarget") {
      sessions.delete(params.sessionId);
      invalidate(params.sessionId);
    } else if (method === "Runtime.executionContextsCleared") {
      invalidate(sessionId);
    } else if (method === "Page.frameNavigated") {
      invalidate(sessionId);
    }
    return true;
  }

  const frameTree = async () => {
    const root = await raw("", "Page.getFrameTree");
    const trees = new Map();
    const children = [...sessions].filter(Boolean);
    for (let start = 0; start < children.length; start += 4) {
      await Promise.all(children.slice(start, start + 4).map(async (sessionId) => {
        let timer;
        try {
          const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Browser frame is not answering")), CHILD_TREE_TIMEOUT); });
          const result = await Promise.race([raw(sessionId, "Page.getFrameTree"), late]);
          if (result.frameTree?.frame?.id) trees.set(result.frameTree.frame.id, { sessionId, tree: result.frameTree });
        } catch {} finally { clearTimeout(timer); }
      }));
    }
    owners.clear();
    const merge = (tree, sessionId, visited = new Set()) => {
      const id = tree?.frame?.id;
      if (!id || visited.has(id) || owners.size >= 256) return tree;
      visited.add(id);
      const child = trees.get(id);
      if (child) { tree = child.tree; sessionId = child.sessionId; }
      owners.set(id, sessionId);
      const nested = [...(tree.childFrames ?? [])];
      for (const { tree: childTree } of trees.values()) {
        if (childTree.frame.parentId === id && !nested.some((frame) => frame.frame?.id === childTree.frame.id)) nested.push(childTree);
      }
      return { ...tree, ...(nested.length && { childFrames: nested.map((frame) => merge(frame, sessionId, visited)) }) };
    };
    return { ...root, frameTree: merge(root.frameTree, "") };
  };

  async function command(method, params) {
    if (method === "Network.enable") {
      network = { ...params };
      for (const child of sessions) if (child) await raw(child, method, network);
    }
    if (method === "Page.getFrameTree") return frameTree();
    let sessionId = "";
    params = { ...params };
    if (method === "Page.createIsolatedWorld") {
      if (!owners.has(params.frameId)) await frameTree();
      if (!owners.has(params.frameId)) throw new Error("Browser frame no longer exists");
      sessionId = owners.get(params.frameId);
    }
    const contextKey = "contextId" in params ? "contextId" : "executionContextId" in params ? "executionContextId" : null;
    if (contextKey) {
      const context = contexts.get(params[contextKey]);
      if (!context) throw new Error("Browser execution context expired; refresh the snapshot");
      sessionId = context.sessionId;
      params[contextKey] = context.id;
    }
    if ("objectId" in params) {
      const object = objects.get(params.objectId);
      if (!object) throw new Error("Browser object expired");
      sessionId = object.sessionId;
      if (method === "Runtime.releaseObject") objects.delete(params.objectId);
      params.objectId = object.id;
    }
    const result = (await raw(sessionId, method, params)) ?? {};
    if (method === "Page.createIsolatedWorld" && Number.isSafeInteger(result.executionContextId)) {
      for (const [id, context] of contexts) {
        if (context.sessionId === sessionId && context.id === result.executionContextId) return { ...result, executionContextId: id };
      }
      if (contexts.size >= MAX_CONTEXTS) throw new Error("Browser frame context limit reached");
      const id = ++counter;
      contexts.set(id, { sessionId, id: result.executionContextId, world: params.worldName });
      return { ...result, executionContextId: id };
    }
    if (result.result?.objectId) {
      if (objects.size >= MAX_OBJECTS) {
        await raw(sessionId, "Runtime.releaseObject", { objectId: result.result.objectId }).catch(() => {});
        throw new Error("Browser object limit reached");
      }
      const id = `anbo-object-${++counter}`;
      objects.set(id, { sessionId, id: result.result.objectId });
      return { ...result, result: { ...result.result, objectId: id } };
    }
    return result;
  }

  async function cleanup() {
    let timer;
    const calls = [raw("", "Runtime.evaluate", { expression: "window.dispatchEvent(new CustomEvent('anbo-automation-visual-hide'));", timeout: 500 }), raw("", "Emulation.clearDeviceMetricsOverride"), raw("", "Emulation.setFocusEmulationEnabled", { enabled: false })];
    for (const context of contexts.values()) {
      if (context.world === "anbo-browser-automation") calls.push(raw(context.sessionId, "Runtime.evaluate", { contextId: context.id, expression: "globalThis.__anboDesign?.uninstall();", timeout: 500 }));
    }
    try { await Promise.race([Promise.allSettled(calls), new Promise((resolve) => { timer = setTimeout(resolve, 1000); })]); }
    finally { clearTimeout(timer); }
  }

  return { start: () => prepare(""), event, command, cleanup, dispose: () => { disposed = true; sessions.clear(); owners.clear(); contexts.clear(); objects.clear(); } };
}
