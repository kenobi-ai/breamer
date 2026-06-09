import { describe, expect, test } from "bun:test";
import type { RuleContext } from "pokayoke";
import { breamerServiceContract } from "./breamer-service-contract.rule";

const baseFiles: Record<string, string> = {
  "package.json": JSON.stringify({
    license: "MIT",
    private: true,
    scripts: {
      build: "tsup",
      deploy: "wrangler deploy"
    }
  }),
  "README.md": "# breamer\n\nCloudflare Workers service.\n",
  "Dockerfile":
    "HEALTHCHECK CMD bun -e \"const token = process.env.ACCESS_TOKEN; const headers = token ? { authorization: 'Bearer ' + token } : undefined;\"\nENTRYPOINT [\"bun\", \"dist/container.js\"]\n",
  "src/worker.ts":
    'if (url.pathname === "/" || url.pathname === SHUTDOWN_PATH) return json({ error: "not_found" });\nif (url.pathname === "/_worker/health" || url.pathname === "/health") { authenticateAccess(request, env); }\n'
};

const runRule = async (files: Record<string, string>) => {
  const context = {
    fix: false,
    glob: async (patterns: string | string[]) => {
      const wanted = Array.isArray(patterns) ? patterns : [patterns];
      return Object.keys(files).filter((file) => wanted.includes(file));
    },
    readFile: async (file: string) => files[file] ?? "",
    root: process.cwd()
  } as RuleContext;

  return breamerServiceContract.run(context);
};

describe("repo/breamer-service-contract", () => {
  test("accepts the service-shaped package", async () => {
    const result = await runRule(baseFiles);
    expect(result.findings).toEqual([]);
  });

  test("rejects the old CLI-shaped package", async () => {
    const result = await runRule({
      ...baseFiles,
      "package.json": JSON.stringify({
        bin: { breamer: "./dist/cli.js" },
        files: ["dist"],
        license: "ISC",
        main: "dist/index.js",
        publishConfig: { access: "public" },
        scripts: { start: "bun dist/cli.js" }
      }),
      "README.md": "## CLI\n\nnpx breamer\n",
      "Dockerfile": 'ENTRYPOINT ["bun", "dist/cli.js"]\n',
      "src/cli.ts": "console.log('old cli')"
    });

    expect(result.findings.length).toBeGreaterThanOrEqual(5);
  });
});
