import childProcess from "node:child_process";
import path from "node:path";
import { z } from "zod";

export type WorkspaceProjectLocation = {
  name: string;
  /** Path relative to the repository root, such as `libs/accounts`. */
  directory: string;
  absolutePath: string;
};

const REPOSITORY_ROOT = path.join(import.meta.dirname, "../../..");

const pnpmProjectListSchema = z.array(z.object({ name: z.string(), path: z.string() }));

/** Lists the workspace projects pnpm sees, without the repository root and the shared stack. */
export function listWorkspaceProjects(): WorkspaceProjectLocation[] {
  const pnpmOutput = childProcess.execFileSync(
    "pnpm",
    ["ls", "--recursive", "--json", "--depth", "-1"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  return pnpmProjectListSchema
    .parse(JSON.parse(pnpmOutput))
    .map(({ name, path: absolutePath }) => ({
      name,
      directory: path.relative(REPOSITORY_ROOT, absolutePath),
      absolutePath,
    }))
    .filter(({ directory }) => directory !== "" && !directory.startsWith(".patricktree-stack/"));
}
