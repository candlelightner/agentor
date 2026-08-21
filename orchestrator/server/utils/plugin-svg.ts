const MAX_PLUGIN_SVG_BYTES = 32 * 1024;

const ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
  svg: new Set([
    "viewBox",
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "opacity",
  ]),
  g: new Set([
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "opacity",
    "transform",
  ]),
  path: new Set([
    "d",
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "opacity",
    "transform",
  ]),
  circle: new Set([
    "cx",
    "cy",
    "r",
    "fill",
    "stroke",
    "stroke-width",
    "opacity",
    "transform",
  ]),
  ellipse: new Set([
    "cx",
    "cy",
    "rx",
    "ry",
    "fill",
    "stroke",
    "stroke-width",
    "opacity",
    "transform",
  ]),
  rect: new Set([
    "x",
    "y",
    "width",
    "height",
    "rx",
    "ry",
    "fill",
    "stroke",
    "stroke-width",
    "opacity",
    "transform",
  ]),
  line: new Set([
    "x1",
    "y1",
    "x2",
    "y2",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "opacity",
    "transform",
  ]),
  polyline: new Set([
    "points",
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "opacity",
    "transform",
  ]),
  polygon: new Set([
    "points",
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "opacity",
    "transform",
  ]),
};

const NUMBER = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
const NUMBER_RE = new RegExp(`^${NUMBER}$`);
const NUMBER_LIST_RE = new RegExp(`^\\s*${NUMBER}(?:[\\s,]+${NUMBER})*\\s*$`);
const VIEWBOX_RE = new RegExp(
  `^\\s*${NUMBER}[\\s,]+${NUMBER}[\\s,]+${NUMBER}[\\s,]+${NUMBER}\\s*$`,
);
const PATH_RE = /^[MmZzLlHhVvCcSsQqTtAaEe0-9+.,\s-]+$/;
const TRANSFORM_RE =
  /^(?:\s*(?:matrix|translate|scale|rotate|skewX|skewY)\s*\([-+eE0-9.,\s]+\)\s*)+$/;
const COLOR_RE = /^(?:none|currentColor|#[0-9a-fA-F]{3,8})$/;
const ENUMS: Record<string, Set<string>> = {
  "stroke-linecap": new Set(["butt", "round", "square"]),
  "stroke-linejoin": new Set(["miter", "round", "bevel"]),
};

export const DEFAULT_PLUGIN_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/><circle cx="12" cy="12" r="3"/></svg>';

/**
 * Sanitizes the deliberately tiny SVG subset accepted for plugin icons.
 * Unsupported markup is rejected as a whole rather than partially repaired.
 * Callers should render the result through an <img>, never v-html.
 */
export function sanitizePluginSvg(input: unknown): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  if (Buffer.byteLength(input, "utf8") > MAX_PLUGIN_SVG_BYTES) return null;
  if (/<!|<\?|&(?:#|[a-z])/i.test(input)) return null;

  const tokenRe = /<\/?[A-Za-z][^<>]*>|[^<]+/g;
  const tokens = input.match(tokenRe);
  if (!tokens || tokens.join("") !== input) return null;

  const stack: string[] = [];
  const output: string[] = [];
  let rootSeen = false;
  for (const token of tokens) {
    if (!token.startsWith("<")) {
      if (token.trim()) return null;
      continue;
    }
    const closing = /^<\/\s*([A-Za-z][A-Za-z0-9-]*)\s*>$/.exec(token);
    if (closing) {
      const name = closing[1]!.toLowerCase();
      if (stack.pop() !== name) return null;
      output.push(`</${name}>`);
      continue;
    }

    const opening = /^<\s*([A-Za-z][A-Za-z0-9-]*)([\s\S]*?)(\/?)>$/.exec(token);
    if (!opening) return null;
    const name = opening[1]!.toLowerCase();
    const allowed = ELEMENT_ATTRIBUTES[name];
    if (!allowed) return null;
    if (!rootSeen) {
      if (name !== "svg") return null;
      rootSeen = true;
    } else if (name === "svg") return null;

    const attrs = parseAttributes(opening[2]!);
    if (!attrs) return null;
    const normalized: string[] = [];
    for (const [attribute, value] of attrs) {
      if (!allowed.has(attribute) || !validAttribute(attribute, value))
        return null;
      normalized.push(`${attribute}="${escapeAttribute(value.trim())}"`);
    }
    if (name === "svg" && !attrs.some(([key]) => key === "viewBox"))
      normalized.unshift('viewBox="0 0 24 24"');
    const selfClosing = opening[3] === "/";
    output.push(
      `<${name}${normalized.length ? ` ${normalized.join(" ")}` : ""}${selfClosing ? "/>" : ">"}`,
    );
    if (!selfClosing) stack.push(name);
  }
  return rootSeen && stack.length === 0 ? output.join("") : null;
}

export function sanitizePluginSvgOrDefault(input: unknown): {
  svg: string;
  fallback: boolean;
} {
  const svg = sanitizePluginSvg(input);
  return svg
    ? { svg, fallback: false }
    : { svg: DEFAULT_PLUGIN_ICON_SVG, fallback: true };
}

function parseAttributes(raw: string): Array<[string, string]> | null {
  const attrs: Array<[string, string]> = [];
  let rest = raw.trim();
  const seen = new Set<string>();
  while (rest) {
    const match =
      /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*/.exec(rest);
    if (!match) return null;
    const key = match[1]!;
    if (
      seen.has(key) ||
      key.toLowerCase().startsWith("on") ||
      key.includes(":")
    )
      return null;
    seen.add(key);
    attrs.push([key, match[2] ?? match[3] ?? ""]);
    rest = rest.slice(match[0].length);
  }
  return attrs;
}

function validAttribute(name: string, value: string): boolean {
  const trimmed = value.trim();
  if (name === "viewBox") return VIEWBOX_RE.test(trimmed);
  if (["fill", "stroke"].includes(name)) return COLOR_RE.test(trimmed);
  if (name === "d") return trimmed.length <= 8_192 && PATH_RE.test(trimmed);
  if (name === "points")
    return trimmed.length <= 4_096 && NUMBER_LIST_RE.test(trimmed);
  if (name === "transform")
    return trimmed.length <= 512 && TRANSFORM_RE.test(trimmed);
  if (ENUMS[name]) return ENUMS[name]!.has(trimmed);
  if (name === "opacity")
    return (
      NUMBER_RE.test(trimmed) && Number(trimmed) >= 0 && Number(trimmed) <= 1
    );
  return NUMBER_RE.test(trimmed);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
