import type { WorkspaceEnv } from "@/modules/workspace";

type AuthorizeWorkspace = (
  path: string,
  workspace: WorkspaceEnv,
) => Promise<string>;

type AuthorizeWorkspaceRootOptions = {
  path: string;
  workspace: WorkspaceEnv;
  authorize: AuthorizeWorkspace;
  commit: (authorizedRoot: string) => void;
};

export async function authorizeWorkspaceRoot({
  path,
  workspace,
  authorize,
  commit,
}: AuthorizeWorkspaceRootOptions): Promise<string> {
  const authorizedRoot = await authorize(path, workspace);
  commit(authorizedRoot);
  return authorizedRoot;
}
