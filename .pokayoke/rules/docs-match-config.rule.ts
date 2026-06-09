import type { Finding } from "pokayoke";
import { defineRule } from "pokayoke";
import {
  escapeRegExp,
  parseJsonc,
  sectionBody,
} from "./docs-match-config.helpers";

const ruleId = "repo/docs-match-config";

type WranglerConfig = {
  account_id?: string;
  containers?: Array<{
    instance_type?: string;
  }>;
  routes?: Array<{
    custom_domain?: boolean;
    pattern?: string;
  }>;
  secrets?: {
    required?: string[];
  };
  vars?: Record<string, string | number | boolean>;
};

const optionalUnsetConfig = ["BREAMER_BROWSER_USER_AGENT"] as const;
const literalDefaultConfig = ["BREAMER_SLEEP_AFTER"] as const;

const finding = (message: string, file: string, advice?: string): Finding => ({
  ruleId,
  severity: "error",
  message,
  file,
  advice,
});

const normalizeMarkdownCell = (cell: string): string =>
  cell.replace(/`/g, "").trim();

const configurationRows = (
  configurationSection: string,
): Map<string, string> => {
  const rows = new Map<string, string>();
  const tableLines = configurationSection
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));

  for (const line of tableLines.slice(2)) {
    const cells = line.slice(1, -1).split("|").map(normalizeMarkdownCell);
    const [setting, defaultValue] = cells;

    if (setting?.startsWith("BREAMER_")) {
      rows.set(setting, defaultValue ?? "");
    }
  }

  return rows;
};

const expectedPublicConfigDocs = (
  vars: WranglerConfig["vars"] = {},
): Map<string, string> => {
  const expected = new Map<string, string>();

  for (const [name, value] of Object.entries(vars)) {
    if (!name.startsWith("BREAMER_")) {
      continue;
    }

    expected.set(
      name,
      literalDefaultConfig.includes(
        name as (typeof literalDefaultConfig)[number],
      )
        ? String(value)
        : "Required",
    );
  }

  for (const name of optionalUnsetConfig) {
    if (!expected.has(name)) {
      expected.set(name, "unset");
    }
  }

  return expected;
};

const requiredContainerEnvNames = (
  expectedDocs: Map<string, string>,
): string[] =>
  [...expectedDocs.entries()]
    .filter(([, documentedStatus]) => documentedStatus === "Required")
    .map(([name]) => name.replace(/^BREAMER_/, ""));

const sleepHorizonPhrases = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }

  const match = /^(\d+)\s*([smhd])$/.exec(value);
  if (!match) {
    return [`${value} container sleep horizon`];
  }

  const [, amount, unit] = match;
  const unitName = {
    s: "second",
    m: "minute",
    h: "hour",
    d: "day",
  }[unit as "s" | "m" | "h" | "d"];

  return [
    `${amount} ${unitName} container sleep horizon`,
    `${amount} ${unitName}${amount === "1" ? "" : "s"} container sleep horizon`,
  ];
};

export const docsMatchConfig = defineRule({
  meta: {
    id: ruleId,
    docs: "Keep README configuration docs synchronized with wrangler.jsonc.",
    kind: "project",
  },

  async run(context) {
    const findings: Finding[] = [];
    const [wranglerText, readme] = await Promise.all([
      context.readFile("wrangler.jsonc"),
      context.readFile("README.md"),
    ]);
    const wrangler = parseJsonc<WranglerConfig>(wranglerText);
    const configurationSection = sectionBody(readme, "Configuration");

    if (!configurationSection) {
      return {
        findings: [
          finding(
            "README must include a Configuration section.",
            "README.md",
            "Document the public BREAMER_* settings sourced from wrangler.jsonc.",
          ),
        ],
      };
    }

    const documentedDefaults = configurationRows(configurationSection);
    const expectedDocs = expectedPublicConfigDocs(wrangler.vars);

    for (const [setting, expectedDefault] of expectedDocs) {
      const documentedDefault = documentedDefaults.get(setting);

      if (documentedDefault === undefined) {
        findings.push(
          finding(
            `README Configuration table is missing ${setting}.`,
            "README.md",
            "Add a row for every public BREAMER_* setting in wrangler.jsonc.",
          ),
        );
        continue;
      }

      if (documentedDefault !== expectedDefault) {
        findings.push(
          finding(
            `README documents ${setting} as "${documentedDefault}", but config expects "${expectedDefault}".`,
            "README.md",
            "Update the Configuration table when wrangler.jsonc or the config contract changes.",
          ),
        );
      }
    }

    for (const setting of documentedDefaults.keys()) {
      if (!expectedDocs.has(setting)) {
        findings.push(
          finding(
            `README Configuration table documents unknown setting ${setting}.`,
            "README.md",
            "Remove stale config rows or add the setting to wrangler.jsonc if it is still supported.",
          ),
        );
      }
    }

    for (const secret of wrangler.secrets?.required ?? []) {
      if (
        !new RegExp(`\\b${escapeRegExp(secret)}\\b`).test(configurationSection)
      ) {
        findings.push(
          finding(
            `README Configuration section is missing required secret ${secret}.`,
            "README.md",
            "Document every required Worker secret from wrangler.jsonc.",
          ),
        );
      }
    }

    if (
      wrangler.account_id &&
      !readme.includes(`Cloudflare account \`${wrangler.account_id}\``)
    ) {
      findings.push(
        finding(
          "README deploy docs do not mention the configured Cloudflare account ID.",
          "README.md",
          "Keep the Deploy section aligned with wrangler.jsonc account_id.",
        ),
      );
    }

    const customDomains = (wrangler.routes ?? [])
      .filter((route) => route.custom_domain && route.pattern)
      .map((route) => route.pattern as string);

    for (const domain of customDomains) {
      if (!readme.includes(`custom domain \`${domain}\``)) {
        findings.push(
          finding(
            `README deploy docs do not mention custom domain ${domain}.`,
            "README.md",
            "Keep the Deploy section aligned with wrangler.jsonc routes.",
          ),
        );
      }
    }

    const instanceType = wrangler.containers?.[0]?.instance_type;
    if (
      instanceType &&
      !readme.includes(`\`${instanceType}\` container sizing`)
    ) {
      findings.push(
        finding(
          "README service summary does not match the configured container size.",
          "README.md",
          "Update the What It Ships summary when the container instance_type changes.",
        ),
      );
    }

    const sleepAfterConfig = wrangler.vars?.BREAMER_SLEEP_AFTER;
    const sleepAfterPhrases = sleepHorizonPhrases(
      sleepAfterConfig === undefined ? undefined : String(sleepAfterConfig),
    );
    if (
      sleepAfterPhrases.length > 0 &&
      !sleepAfterPhrases.some((phrase) => readme.includes(phrase))
    ) {
      findings.push(
        finding(
          "README service summary does not match the configured sleep horizon.",
          "README.md",
          "Update the What It Ships summary when BREAMER_SLEEP_AFTER changes.",
        ),
      );
    }

    const dockerSection = sectionBody(readme, "Docker") ?? "";
    for (const envName of requiredContainerEnvNames(expectedDocs)) {
      if (!new RegExp(`\\b${escapeRegExp(envName)}\\b`).test(dockerSection)) {
        findings.push(
          finding(
            `README Docker section is missing required container env var ${envName}.`,
            "README.md",
            "Keep the direct-container instructions aligned with the Worker-injected env vars.",
          ),
        );
      }
    }

    return { findings };
  },
});
