/*
 * Sentry's server SDK (`@sentry/cloudflare`) and its client SDK (`@sentry/capacitor` with
 * `@sentry/react`) move on different majors, each with its own `@sentry/core`. The `sentry-server`
 * and `sentry-client` catalogs in pnpm-workspace.yaml keep the versions apart; this check keeps the
 * packages apart, so the two majors never meet in one package.
 */

export type PackageDependencies = {
  name: string;
  /** Path relative to the repository root, such as `libs/accounts`. */
  directory: string;
  /** Every dependency, dev and peer dependency of the package, name to version specifier. */
  dependencies: Record<string, string>;
};

const SERVER_TELEMETRY_LIBRARY = "@cup/telemetry.cloudflare";
const SERVER_SDK = "@sentry/cloudflare";
const CLIENT_SDKS = new Set(["@sentry/browser", "@sentry/capacitor", "@sentry/react"]);
const CLIENT_SDK_PACKAGES = new Set(["@cup/telemetry.browser", "@cup/web-app"]);
/** A build tool that uploads debug files, used next to either family; it is in neither. */
const SENTRY_CLI = "@sentry/cli";

/**
 * Checks three rules: only the server telemetry library and its dependents depend on the server
 * SDK; only the browser telemetry library and the web app depend on a client SDK; and no package
 * depends on both families. A Sentry package belongs to the family of its SDK, or of its catalog
 * for a shared package such as `@sentry/core`.
 */
export function findSentrySdkFamilyProblems(packages: PackageDependencies[]): string[] {
  const problems: string[] = [];

  for (const { name, directory, dependencies } of packages) {
    const sentryDependencies = Object.entries(dependencies).filter(
      ([dependency]) => dependency.startsWith("@sentry/") && dependency !== SENTRY_CLI,
    );

    if (
      dependencies[SERVER_SDK] !== undefined &&
      name !== SERVER_TELEMETRY_LIBRARY &&
      dependencies[SERVER_TELEMETRY_LIBRARY] === undefined
    ) {
      problems.push(
        `\`${name}\` depends on \`${SERVER_SDK}\`; only \`${SERVER_TELEMETRY_LIBRARY}\` and packages that depend on it may. Add \`${SERVER_TELEMETRY_LIBRARY}\` to ${directory}/package.json, or use \`@sentry/core\` from the \`sentry-server\` catalog.`,
      );
    }

    const clientSdk = sentryDependencies.find(([dependency]) => CLIENT_SDKS.has(dependency));
    if (clientSdk !== undefined && !CLIENT_SDK_PACKAGES.has(name)) {
      problems.push(
        `\`${name}\` depends on \`${clientSdk[0]}\`; only ${[...CLIENT_SDK_PACKAGES].map((entry) => `\`${entry}\``).join(" and ")} may depend on the client SDK family.`,
      );
    }

    const serverFamily = sentryDependencies
      .filter(([dependency, specifier]) => familyOf(dependency, specifier) === "server")
      .map(([dependency]) => `\`${dependency}\``);
    const clientFamily = sentryDependencies
      .filter(([dependency, specifier]) => familyOf(dependency, specifier) === "client")
      .map(([dependency]) => `\`${dependency}\``);
    if (serverFamily.length > 0 && clientFamily.length > 0) {
      problems.push(
        `\`${name}\` depends on both Sentry SDK families (server: ${serverFamily.join(", ")}; client: ${clientFamily.join(", ")}); keep each package on one family.`,
      );
    }
  }
  return problems;
}

function familyOf(dependency: string, specifier: string): "server" | "client" | undefined {
  if (dependency === SERVER_SDK || specifier === "catalog:sentry-server") {
    return "server";
  }
  if (CLIENT_SDKS.has(dependency) || specifier === "catalog:sentry-client") {
    return "client";
  }
  return undefined;
}
