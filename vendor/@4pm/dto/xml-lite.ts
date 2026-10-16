/**
 * A small, dependency-free XML reader / writer for the draw.io files of the system diagram — elements,
 * attributes (in source order) and text; comments, processing instructions and doctypes are skipped. Enough for
 * `mxfile` / `mxGraphModel` documents; not a general-purpose XML parser (no namespaces, no DTD entities).
 * @adr 0530 @arch 0057
 */

/** One XML element. */
export interface XmlElement {
  name: string;
  /** Attributes in source order. */
  attrs: [string, string][];
  children: XmlNode[];
}

/** An element or a text run. */
export type XmlNode = XmlElement | string;

/** A parse failure (0-based character offset). */
export class XmlParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

/** An element name / attribute name. */
const NAME_RE = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;

/** Decode the predefined and numeric character references of a text / attribute value. */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[e]!;
  });
}

/** Escape an attribute value (draw.io writes newlines as `&#xa;`). */
export function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#xa;").replace(/\r/g, "&#xd;").replace(/\t/g, "&#x9;");
}

/** Escape a text run. */
function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Parse an XML document and return its root element. Whitespace-only text is dropped. Throws `XmlParseError`
 * on malformed input.
 */
export function parseXml(src: string): XmlElement {
  let i = 0;
  const fail = (msg: string): never => {
    throw new XmlParseError(msg, i);
  };
  const skipMisc = (): void => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i]!)) i++;
      if (src.startsWith("<?", i)) {
        const e = src.indexOf("?>", i);
        if (e < 0) fail("unterminated processing instruction");
        i = e + 2;
      } else if (src.startsWith("<!--", i)) {
        const e = src.indexOf("-->", i);
        if (e < 0) fail("unterminated comment");
        i = e + 3;
      } else if (src.startsWith("<!DOCTYPE", i) || src.startsWith("<!doctype", i)) {
        const e = src.indexOf(">", i);
        if (e < 0) fail("unterminated doctype");
        i = e + 1;
      } else return;
    }
  };
  const name = (): string => {
    NAME_RE.lastIndex = i;
    const m = NAME_RE.exec(src);
    if (!m) fail("expected a name");
    i += m![0].length;
    return m![0];
  };
  const element = (): XmlElement => {
    if (src[i] !== "<") fail("expected <");
    i++;
    const el: XmlElement = { name: name(), attrs: [], children: [] };
    for (;;) {
      while (/\s/.test(src[i] ?? "")) i++;
      if (src.startsWith("/>", i)) {
        i += 2;
        return el;
      }
      if (src[i] === ">") {
        i++;
        break;
      }
      if (i >= src.length) fail(`unterminated <${el.name}>`);
      const an = name();
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] !== "=") fail(`attribute ${an} has no value`);
      i++;
      while (/\s/.test(src[i] ?? "")) i++;
      const q = src[i];
      if (q !== '"' && q !== "'") fail(`attribute ${an} is not quoted`);
      const end = src.indexOf(q!, i + 1);
      if (end < 0) fail(`attribute ${an} is not closed`);
      el.attrs.push([an, decodeXmlEntities(src.slice(i + 1, end))]);
      i = end + 1;
    }
    for (;;) {
      if (i >= src.length) fail(`<${el.name}> is not closed`);
      if (src.startsWith("</", i)) {
        i += 2;
        const n = name();
        if (n !== el.name) fail(`</${n}> closes <${el.name}>`);
        while (/\s/.test(src[i] ?? "")) i++;
        if (src[i] !== ">") fail("expected >");
        i++;
        return el;
      }
      if (src.startsWith("<!--", i)) {
        const e = src.indexOf("-->", i);
        if (e < 0) fail("unterminated comment");
        i = e + 3;
        continue;
      }
      if (src.startsWith("<![CDATA[", i)) {
        const e = src.indexOf("]]>", i);
        if (e < 0) fail("unterminated CDATA");
        el.children.push(src.slice(i + 9, e));
        i = e + 3;
        continue;
      }
      if (src[i] === "<") {
        el.children.push(element());
        continue;
      }
      const next = src.indexOf("<", i);
      const text = src.slice(i, next < 0 ? src.length : next);
      if (text.trim()) el.children.push(decodeXmlEntities(text));
      i = next < 0 ? src.length : next;
    }
  };
  skipMisc();
  const root = element();
  skipMisc();
  if (i < src.length) fail("content after the root element");
  return root;
}

/** An attribute value of an element, or undefined. */
export function xmlAttr(el: XmlElement, name: string): string | undefined {
  return el.attrs.find(([k]) => k === name)?.[1];
}

/** Set (or, with undefined, remove) an attribute, keeping the order of the others. */
export function setXmlAttr(el: XmlElement, name: string, value: string | undefined): void {
  const i = el.attrs.findIndex(([k]) => k === name);
  if (value === undefined) {
    if (i >= 0) el.attrs.splice(i, 1);
  } else if (i >= 0) el.attrs[i] = [name, value];
  else el.attrs.push([name, value]);
}

/** The child elements of an element (optionally only those named `name`). */
export function xmlChildren(el: XmlElement, name?: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => typeof c !== "string" && (!name || c.name === name));
}

/** A deep copy of an element. */
export function cloneXml(el: XmlElement): XmlElement {
  return { name: el.name, attrs: el.attrs.map(([k, v]) => [k, v]), children: el.children.map((c) => (typeof c === "string" ? c : cloneXml(c))) };
}

/** Serialize an element; `indent` > 0 pretty-prints one element per line (text-holding elements stay inline). */
export function serializeXml(el: XmlElement, indent = 0, depth = 0): string {
  const pad = indent ? " ".repeat(indent * depth) : "";
  const attrs = el.attrs.map(([k, v]) => ` ${k}="${escapeXmlAttr(v)}"`).join("");
  if (el.children.length === 0) return `${pad}<${el.name}${attrs} />`;
  const hasText = el.children.some((c) => typeof c === "string");
  if (!indent || hasText) {
    const inner = el.children.map((c) => (typeof c === "string" ? escapeXmlText(c) : serializeXml(c))).join("");
    return `${pad}<${el.name}${attrs}>${inner}</${el.name}>`;
  }
  const inner = el.children.map((c) => serializeXml(c as XmlElement, indent, depth + 1)).join("\n");
  return `${pad}<${el.name}${attrs}>\n${inner}\n${pad}</${el.name}>`;
}

/** A canonical form for comparisons: attributes sorted by name, no formatting. */
export function canonicalXml(el: XmlElement): string {
  const attrs = [...el.attrs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => ` ${k}="${escapeXmlAttr(v)}"`).join("");
  const inner = el.children.map((c) => (typeof c === "string" ? escapeXmlText(c) : canonicalXml(c))).join("");
  return `<${el.name}${attrs}>${inner}</${el.name}>`;
}
