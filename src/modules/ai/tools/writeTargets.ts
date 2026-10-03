import { native } from "../lib/native";
import { checkWritableCanonical } from "../lib/security";
import { resolvePath, type ToolContext } from "./context";

/**
 * Write targets for one tool set, each path checked once. The approval check
 * and execute share them, so the target the user approves is the one written.
 */
export function writeTargets(ctx: ToolContext) {
  const canonicalize = (path: string) =>
    native.canonicalize(path, ctx.getWorkspaceEnv());
  const checked = new Map<string, ReturnType<typeof checkWritableCanonical>>();
  const resolve = (path: string) => {
    const reqPath = resolvePath(path, ctx.getCwd());
    let target = checked.get(path);
    if (!target) {
      target = checkWritableCanonical(reqPath, canonicalize);
      checked.set(path, target);
    }
    return { reqPath, target };
  };
  /** Approval for a tool that writes `path`: resolve it, then ask the user. */
  const approve = async ({ path }: { path: string }) => {
    await resolve(path).target;
    return "user-approval" as const;
  };
  return { resolve, approve };
}
