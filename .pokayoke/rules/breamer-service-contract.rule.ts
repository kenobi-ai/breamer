import type { Finding } from "pokayoke";
import { defineRule } from "pokayoke";

const ruleId = "repo/breamer-service-contract";

const finding = (message: string, file: string, advice?: string): Finding => ({
  ruleId,
  severity: "error",
  message,
  file,
  advice,
});

export const breamerServiceContract = defineRule({
  meta: {
    id: ruleId,
    docs: "Keep breamer as private Cloudflare Workers + Containers infrastructure, not an npm package or public CLI.",
    kind: "project",
  },

  async run(context) {
    const findings: Finding[] = [];
    const [packageJsonText, readme, dockerfile, worker] = await Promise.all([
      context.readFile("package.json"),
      context.readFile("README.md"),
      context.readFile("Dockerfile"),
      context.readFile("src/worker.ts"),
    ]);
    const packageJson = JSON.parse(packageJsonText) as {
      bin?: unknown;
      exports?: unknown;
      files?: string[];
      keywords?: unknown;
      license?: string;
      main?: unknown;
      module?: unknown;
      private?: boolean;
      publishConfig?: unknown;
      scripts?: Record<string, string>;
      types?: unknown;
    };
    const cliFiles = await context.glob("src/cli.ts");

    if (packageJson.license !== "MIT") {
      findings.push(
        finding("package.json must keep breamer MIT licensed.", "package.json"),
      );
    }

    if (packageJson.private !== true) {
      findings.push(
        finding(
          "package.json must stay private.",
          "package.json",
          "This repo deploys through Cloudflare, not npm.",
        ),
      );
    }

    for (const field of [
      "exports",
      "files",
      "keywords",
      "main",
      "module",
      "publishConfig",
      "types",
    ] as const) {
      if (packageJson[field] !== undefined) {
        findings.push(
          finding(
            `package.json must not define npm publication field "${field}".`,
            "package.json",
            "Keep only the Bun/Wrangler service manifest fields needed to build and deploy.",
          ),
        );
      }
    }

    if (packageJson.bin !== undefined) {
      findings.push(
        finding(
          "package.json must not expose a public bin.",
          "package.json",
          "Breamer is a Cloudflare Workers service; keep Docker as the runtime entrypoint.",
        ),
      );
    }

    for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
      if (/dist\/cli\.js|npx\s+breamer/.test(command)) {
        findings.push(
          finding(
            `script "${name}" points at the old CLI surface.`,
            "package.json",
            "Use Worker, Docker, test, deploy, and check scripts only.",
          ),
        );
      }
    }

    if (cliFiles.length > 0) {
      findings.push(
        finding(
          "src/cli.ts must stay deleted.",
          "src/cli.ts",
          "The container process starts through src/server.ts.",
        ),
      );
    }

    if (/npx\s+breamer|##\s*CLI/i.test(readme)) {
      findings.push(
        finding(
          "README must not advertise breamer as a CLI.",
          "README.md",
          "Document the Cloudflare Worker API and container workflow instead.",
        ),
      );
    }

    if (/dist\/cli\.js/.test(dockerfile)) {
      findings.push(
        finding(
          "Dockerfile must not start dist/cli.js.",
          "Dockerfile",
          "Use the Bun-native container source entrypoint.",
        ),
      );
    }

    if (!/ENTRYPOINT \["bun", "src\/server\.ts"\]/.test(dockerfile)) {
      findings.push(
        finding(
          "Dockerfile must run the Bun-native container source entrypoint.",
          "Dockerfile",
          "The runtime image should start src/server.ts directly instead of a generated dist artifact.",
        ),
      );
    }

    if (!/authorization:\s*'Bearer '\s*\+\s*token/.test(dockerfile)) {
      findings.push(
        finding(
          "Docker healthcheck must pass ACCESS_TOKEN when one is configured.",
          "Dockerfile",
          "Health is intentionally auth-gated.",
        ),
      );
    }

    if (!/url\.pathname === "\/"[\s\S]*not_found/.test(worker)) {
      findings.push(
        finding(
          "Worker root route must remain unavailable.",
          "src/worker.ts",
          "The public API starts at authenticated /cdp.",
        ),
      );
    }

    if (!/url\.pathname === "\/health"[\s\S]*authenticateAccess/.test(worker)) {
      findings.push(
        finding("Worker health route must remain auth-gated.", "src/worker.ts"),
      );
    }

    return { findings };
  },
});
