export type PackageDependencies = {
  name: string;
  directory: string;
  dependencies: Record<string, string>;
};

const SERVER_TELEMETRY_LIBRARY = "@cup/telemetry.cloudflare";
const SERVER_SDK = "@sentry/cloudflare";
const CLIENT_SDKS = new Set(["@sentry/browser", "@sentry/capacitor", "@sentry/react"]);
const CLIENT_SDK_PACKAGES = new Set(["@cup/telemetry.browser", "@cup/web-app", "@cup/mobile-app"]);
const CLIENT_SDK_PACKAGE_LIST = new Intl.ListFormat("en-GB", { type: "conjunction" }).format(
  [...CLIENT_SDK_PACKAGES].map((entry) => `\`${entry}\``),
);
const SENTRY_CLI = "@sentry/cli";

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
        `\`${name}\` depends on \`${clientSdk[0]}\`; only ${CLIENT_SDK_PACKAGE_LIST} may depend on the client SDK family.`,
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
