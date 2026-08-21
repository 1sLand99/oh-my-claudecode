/**
 * Shared frontmatter parsing utilities
 *
 * Parses YAML-like frontmatter from markdown files.
 * Used by both the builtin-skills loader and the auto-slash-command executor.
 */

/**
 * Remove surrounding single or double quotes from a trimmed value.
 */
export function stripOptionalQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Parse YAML-like frontmatter from markdown content.
 * Returns { metadata, body } where metadata is a flat string map.
 */
export function parseFrontmatter(content: string): { metadata: Record<string, string>; body: string } {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { metadata: {}, body: content };
  }

  const [, yamlContent, body] = match;
  const metadata: Record<string, string> = {};
  const lines = yamlContent.split('\n');
  const rootLine = lines.find((line) => {
    const trimmed = line.trimStart();
    return trimmed.length > 0 && !trimmed.startsWith('#') && trimmed.includes(':');
  });
  const rootIndent = rootLine === undefined ? undefined : rootLine.length - rootLine.trimStart().length;

  let flowDepth = 0;
  let quote: "'" | '"' | null = null;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (flowDepth === 0) {
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (indent !== rootIndent) continue;

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.slice(0, colonIndex).trim();
      const value = stripOptionalQuotes(line.slice(colonIndex + 1));

      metadata[key] = value;
    } else {
      // Inside an unterminated multiline flow collection ({...} / [...]) every line is a
      // continuation member, never a root mapping key — even when it shares the root
      // indentation. Matches js-yaml, which nests these members under the opener.
    }

    // Track flow collection structure across lines. Runs for root keys (an opener like
    // `metadata: {` starts a collection) and for every line inside one (to find its end).
    // Quoted scalars and comments never open or close flow structure.
    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (quote) {
        if (quote === '"' && char === '\\') {
          i++;
          continue;
        }
        if (char === quote) {
          if (quote === "'" && line[i + 1] === "'") {
            i++;
            continue;
          }
          quote = null;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
        break;
      }
      if (char === '{' || char === '[') {
        flowDepth++;
      } else if ((char === '}' || char === ']') && flowDepth > 0) {
        flowDepth--;
      }
    }
  }

  return { metadata, body };
}

/**
 * Parse the `aliases` frontmatter field into an array of strings.
 * Supports inline YAML list: `aliases: [foo, bar]` or single value.
 */
export function parseFrontmatterAliases(rawAliases: string | undefined): string[] {
  return parseFrontmatterList(rawAliases);
}

/**
 * Parse a generic frontmatter list field into an array of strings.
 * Supports inline YAML list syntax: `[foo, bar]` or a single scalar value.
 */
export function parseFrontmatterList(rawValue: string | undefined): string[] {
  if (!rawValue) return [];

  const trimmed = rawValue.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];

    return inner
      .split(',')
      .map((item) => stripOptionalQuotes(item))
      .filter((item) => item.length > 0);
  }

  const singleValue = stripOptionalQuotes(trimmed);
  return singleValue ? [singleValue] : [];
}
