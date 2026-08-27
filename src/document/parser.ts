import type { Root as UnistRoot } from "mdast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type {
  RichDocument,
  RichMathExpression,
  RichMedia,
  RichMediaSource,
  SafeElement,
  SafeNode,
  SafeRoot,
} from "./model.js";

const safeSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "video", "source"],
  attributes: {
    ...defaultSchema.attributes,
    video: [
      "src",
      "poster",
      "controls",
      "autoplay",
      "loop",
      "muted",
      "preload",
      "width",
      "height",
      "title",
    ],
    source: ["src", "type"],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: ["http", "https"],
    poster: ["http", "https"],
  },
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, safeSchema);

export async function parseRichDocument(source: string): Promise<RichDocument> {
  const mdast = processor.parse(source) as UnistRoot;
  const math = collectMath(mdast, source);
  const transformed = await processor.run(mdast);
  const safeTree = toSafeRoot(transformed);
  const media = attachMediaOffsets(collectMedia(safeTree), source);
  return {
    source,
    safeTree,
    media,
    math,
  };
}

function attachMediaOffsets(media: RichMedia[], source: string): RichMedia[] {
  let cursor = 0;
  return media.map((item) => {
    const uri = item.sources[0]?.uri;
    if (!uri) return item;
    const startOffset = source.indexOf(uri, cursor);
    if (startOffset < 0) return item;
    cursor = startOffset + uri.length;
    return {
      ...item,
      startOffset,
      endOffset: startOffset + uri.length,
    };
  });
}

function collectMath(root: unknown, documentSource: string): RichMathExpression[] {
  const expressions: RichMathExpression[] = [];
  walkUnknown(root, (node) => {
    if (node.type !== "math" && node.type !== "inlineMath") return;
    const source = typeof node.value === "string" ? node.value : "";
    const position = isRecord(node.position) ? node.position : undefined;
    const start = isRecord(position?.start) ? position.start : undefined;
    const end = isRecord(position?.end) ? position.end : undefined;
    const startOffset = finiteNumber(start?.offset);
    const endOffset = finiteNumber(end?.offset);
    const raw =
      startOffset !== undefined && endOffset !== undefined
        ? documentSource.slice(startOffset, endOffset)
        : "";
    expressions.push({
      id: `math-${expressions.length + 1}`,
      source,
      // remark-math treats a compact `$$...$$` pair as inlineMath, but the
      // Markdown convention still means display math. Preserve that semantic
      // distinction before the UI renderer receives only the AST node.
      display: node.type === "math" || raw.startsWith("$$"),
      startOffset,
      endOffset,
    });
  });
  return expressions;
}

function collectMedia(root: SafeRoot): RichMedia[] {
  const media: RichMedia[] = [];
  const visit = (node: SafeNode): void => {
    if (node.type === "root") {
      for (const child of node.children) visit(child);
      return;
    }
    if (node.type !== "element") return;
    if (node.tagName === "img") {
      const src = stringProperty(node, "src");
      if (src) {
        media.push({
          id: `media-${media.length + 1}`,
          kind: "image",
          sources: [{ uri: src }],
          alt: stringProperty(node, "alt"),
          title: stringProperty(node, "title"),
          controls: false,
          autoplay: false,
          loop: false,
          muted: true,
        });
      }
      return;
    }
    if (node.tagName === "video") {
      const sources: RichMediaSource[] = [];
      const src = stringProperty(node, "src");
      if (src) sources.push({ uri: src });
      for (const child of node.children) {
        if (child.type !== "element" || child.tagName !== "source") continue;
        const childSrc = stringProperty(child, "src");
        if (!childSrc) continue;
        const mimeType = stringProperty(child, "type");
        sources.push({ uri: childSrc, ...(mimeType ? { mimeType } : {}) });
      }
      if (sources.length > 0) {
        media.push({
          id: `media-${media.length + 1}`,
          kind: "video",
          sources,
          title: stringProperty(node, "title"),
          posterUri: stringProperty(node, "poster"),
          controls: booleanProperty(node, "controls"),
          autoplay: booleanProperty(node, "autoplay"),
          loop: booleanProperty(node, "loop"),
          muted: booleanProperty(node, "muted"),
        });
      }
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return media;
}

function toSafeRoot(value: unknown): SafeRoot {
  if (!isRecord(value) || value.type !== "root" || !Array.isArray(value.children)) {
    throw new Error("Markdown processor did not produce a safe root");
  }
  return {
    type: "root",
    children: value.children.map(toSafeNode).filter((node): node is SafeNode => node !== null),
  };
}

function toSafeNode(value: unknown): SafeNode | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "text") {
    return { type: "text", value: typeof value.value === "string" ? value.value : "" };
  }
  if (value.type === "root") return toSafeRoot(value);
  if (value.type !== "element" || typeof value.tagName !== "string") return null;
  const properties = isRecord(value.properties) ? structuredClone(value.properties) : {};
  const children = Array.isArray(value.children)
    ? value.children.map(toSafeNode).filter((node): node is SafeNode => node !== null)
    : [];
  return {
    type: "element",
    tagName: value.tagName,
    properties,
    children,
  } satisfies SafeElement;
}

function stringProperty(element: SafeElement, name: string): string | undefined {
  const value = element.properties[name];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function booleanProperty(element: SafeElement, name: string): boolean {
  const value = element.properties[name];
  return value === true || value === "" || value === name;
}

function walkUnknown(value: unknown, visitor: (record: UnknownNodeRecord) => void): void {
  if (!isRecord(value)) return;
  visitor(value);
  const children = value.children;
  if (!Array.isArray(children)) return;
  for (const child of children) walkUnknown(child, visitor);
}

interface UnknownNodeRecord extends Record<string, unknown> {
  type?: unknown;
  value?: unknown;
  tagName?: unknown;
  properties?: unknown;
  children?: unknown;
  position?: unknown;
  start?: unknown;
  end?: unknown;
  offset?: unknown;
}

function isRecord(value: unknown): value is UnknownNodeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
