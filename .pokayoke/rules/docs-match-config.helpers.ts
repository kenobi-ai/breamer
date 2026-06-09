const stripJsoncComments = (text: string): string => {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (character === "\n") {
        output += character;
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        index++;
        continue;
      }
      if (character === "\n") {
        output += character;
      }
      continue;
    }

    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === "/" && next === "/") {
      inLineComment = true;
      index++;
      continue;
    }

    if (character === "/" && next === "*") {
      inBlockComment = true;
      index++;
      continue;
    }

    if (character === '"') {
      inString = true;
    }

    output += character;
  }

  return output;
};

const removeTrailingCommas = (text: string): string => {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];

    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }

    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/.test(text[lookahead] ?? "")) {
        lookahead++;
      }
      if (text[lookahead] === "}" || text[lookahead] === "]") {
        continue;
      }
    }

    output += character;
  }

  return output;
};

export const parseJsonc = <T>(text: string): T =>
  JSON.parse(removeTrailingCommas(stripJsoncComments(text))) as T;

export const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const sectionBody = (
  markdown: string,
  heading: string,
): string | undefined => {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);

  if (start === -1) {
    return undefined;
  }

  const end = lines.findIndex(
    (line, index) => index > start && /^##\s/.test(line),
  );

  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
};
