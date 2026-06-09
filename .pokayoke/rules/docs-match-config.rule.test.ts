import { describe, expect, test } from "bun:test";
import type { RuleContext } from "pokayoke";
import { docsMatchConfig } from "./docs-match-config.rule";

const wranglerConfig = {
  account_id: "account-123",
  routes: [
    {
      custom_domain: true,
      pattern: "breamer.example.com",
    },
  ],
  vars: {
    BREAMER_PAGE_TIMEOUT_MS: "300000",
    BREAMER_CHROME_HEAP_SIZE_MB: "4096",
    BREAMER_BROWSER_WIDTH: "1470",
    BREAMER_BROWSER_HEIGHT: "956",
    BREAMER_BROWSER_DEVICE_SCALE_FACTOR: "1",
    BREAMER_BROWSER_LOCALE: "en-US,en",
    BREAMER_SLEEP_AFTER: "5m",
  },
  secrets: {
    required: ["BREAMER_ACCESS_TOKEN"],
  },
  containers: [
    {
      instance_type: "standard-4",
    },
  ],
};

const matchingReadme = `# breamer

## What It Ships

- A 5 minute container sleep horizon for jobs that fail to clean up.
- \`standard-4\` container sizing, configured Chromium heap/window settings, broad Linux font coverage, and structured browser lifecycle logs.

## Deploy

\`wrangler.jsonc\` pins this project to Cloudflare account \`account-123\` and custom domain \`breamer.example.com\`.

## Configuration

Non-secret settings live in \`wrangler.jsonc\`.

| Setting | Default | Purpose |
| --- | --- | --- |
| \`BREAMER_PAGE_TIMEOUT_MS\` | Required | Idle page cleanup inside the container. |
| \`BREAMER_CHROME_HEAP_SIZE_MB\` | Required | Chromium V8 heap size. |
| \`BREAMER_BROWSER_WIDTH\` | Required | Initial browser width. |
| \`BREAMER_BROWSER_HEIGHT\` | Required | Initial browser height. |
| \`BREAMER_BROWSER_DEVICE_SCALE_FACTOR\` | Required | Initial device scale factor. |
| \`BREAMER_BROWSER_LOCALE\` | Required | Chromium locale. |
| \`BREAMER_BROWSER_USER_AGENT\` | unset | Optional user agent override. |
| \`BREAMER_SLEEP_AFTER\` | \`5m\` | Cloudflare Container sleep horizon. |

Secret:

\`\`\`bash
BREAMER_ACCESS_TOKEN=<long random token>
\`\`\`

## Docker

If you run the raw container directly, pass \`PAGE_TIMEOUT_MS\`, \`CHROME_HEAP_SIZE_MB\`, \`BROWSER_WIDTH\`, \`BROWSER_HEIGHT\`, \`BROWSER_DEVICE_SCALE_FACTOR\`, and \`BROWSER_LOCALE\`.
`;

const runRule = async ({
  readme = matchingReadme,
  wrangler = wranglerConfig,
}: {
  readme?: string;
  wrangler?: typeof wranglerConfig;
} = {}) => {
  const context = {
    fix: false,
    readFile: async (file: string) =>
      file === "wrangler.jsonc" ? JSON.stringify(wrangler) : readme,
    root: process.cwd(),
  } as RuleContext;

  return docsMatchConfig.run(context);
};

describe("repo/docs-match-config", () => {
  test("accepts README docs that match wrangler config", async () => {
    const result = await runRule();

    expect(result.findings).toEqual([]);
  });

  test("rejects stale literal docs when wrangler config changes", async () => {
    const result = await runRule({
      wrangler: {
        ...wranglerConfig,
        vars: {
          ...wranglerConfig.vars,
          BREAMER_SLEEP_AFTER: "10m",
        },
      },
    });

    expect(result.findings.map((finding) => finding.message)).toContain(
      'README documents BREAMER_SLEEP_AFTER as "5m", but config expects "10m".',
    );
    expect(result.findings.map((finding) => finding.message)).toContain(
      "README service summary does not match the configured sleep horizon.",
    );
  });

  test("rejects omitted new public vars and required secrets", async () => {
    const result = await runRule({
      wrangler: {
        ...wranglerConfig,
        vars: {
          ...wranglerConfig.vars,
          BREAMER_NEW_SETTING: "enabled",
        },
        secrets: {
          required: ["BREAMER_ACCESS_TOKEN", "BREAMER_SECOND_SECRET"],
        },
      },
    });

    expect(result.findings.map((finding) => finding.message)).toContain(
      "README Configuration table is missing BREAMER_NEW_SETTING.",
    );
    expect(result.findings.map((finding) => finding.message)).toContain(
      "README Configuration section is missing required secret BREAMER_SECOND_SECRET.",
    );
    expect(result.findings.map((finding) => finding.message)).toContain(
      "README Docker section is missing required container env var NEW_SETTING.",
    );
  });
});
