type ExportsField =
  | string
  | Record<string, string | { [condition: string]: string; default: string }>;

export type WorkspaceProject = {
  name: string;
  directory: string;
  exports: ExportsField | undefined;
  subpathExportExceptions: Record<string, string>;
  readFile: (relativePath: string) => Promise<string>;
};

const PRODUCTION_DIRECTORIES = ["apps/", "libs/"];
const ROOT_INDEX = "./src/index.ts";
const LOCAL_RE_EXPORT = /^export\s[^;]*?\sfrom\s+["'](?:#src\/|\.{1,2}\/)/m;

export async function findPackageExportProblems(projects: WorkspaceProject[]): Promise<string[]> {
  const problems: string[] = [];

  for (const project of projects) {
    const targets = readExportTargets(project);
    const manifestPath = `${project.directory}/package.json`;
    const isProductionPackage = PRODUCTION_DIRECTORIES.some((directory) =>
      project.directory.startsWith(directory),
    );

    const productionSubpaths = new Set<string>();
    for (const [subpath, target] of targets) {
      if (subpath === "." || !isProductionPackage || !isProductionTarget(target)) {
        continue;
      }

      productionSubpaths.add(subpath);
      if (project.subpathExportExceptions[subpath] === undefined) {
        problems.push(
          `\`${project.name}\` exports production code \`${target}\` at \`${subpath}\`; re-export it from \`.\`, or list \`${subpath}\` with its reason under \`cup.subpathExportExceptions\` in ${manifestPath}.`,
        );
      }
    }

    for (const subpath of Object.keys(project.subpathExportExceptions)) {
      if (!productionSubpaths.has(subpath)) {
        problems.push(
          `\`${project.name}\` lists \`${subpath}\` under \`cup.subpathExportExceptions\`, but it is not a production subpath export; remove the entry from ${manifestPath}.`,
        );
      }
    }

    const rootTarget = targets.get(".");
    if (
      rootTarget !== undefined &&
      rootTarget !== ROOT_INDEX &&
      LOCAL_RE_EXPORT.test(await project.readFile(rootTarget))
    ) {
      problems.push(
        `\`${project.name}\` re-exports other files from its \`.\` export \`${rootTarget}\`; move the re-exports into \`${ROOT_INDEX}\` and point \`.\` there.`,
      );
    }
  }
  return problems;
}

function isProductionTarget(target: string): boolean {
  return target.startsWith("./src/") && !target.endsWith(".fake.ts");
}

function readExportTargets(project: WorkspaceProject): Map<string, string> {
  const targets = new Map<string, string>();
  if (project.exports === undefined) {
    return targets;
  }

  const entries =
    typeof project.exports === "string"
      ? [[".", project.exports] as const]
      : Object.entries(project.exports);
  for (const [subpath, value] of entries) {
    targets.set(subpath, typeof value === "string" ? value : value.default);
  }
  return targets;
}
