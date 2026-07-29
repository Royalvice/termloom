export type RichMediaKind = "image" | "video";

export interface RichMediaSource {
  uri: string;
  mimeType?: string;
}

export interface RichMedia {
  id: string;
  kind: RichMediaKind;
  sources: readonly RichMediaSource[];
  alt?: string;
  title?: string;
  posterUri?: string;
  controls: boolean;
  autoplay: boolean;
  loop: boolean;
  muted: boolean;
}

export interface RichMathExpression {
  id: string;
  source: string;
  display: boolean;
  startOffset?: number;
  endOffset?: number;
}

export interface RichDocument {
  source: string;
  safeTree: SafeRoot;
  media: readonly RichMedia[];
  math: readonly RichMathExpression[];
}

export interface SafeRoot {
  type: "root";
  children: readonly SafeNode[];
}

export type SafeNode = SafeRoot | SafeElement | SafeText;

export interface SafeElement {
  type: "element";
  tagName: string;
  properties: Readonly<Record<string, unknown>>;
  children: readonly SafeNode[];
}

export interface SafeText {
  type: "text";
  value: string;
}

export type ResourceLocation =
  | LocalResourceLocation
  | RemoteResourceLocation
  | HttpResourceLocation;

export interface LocalResourceLocation {
  scheme: "file";
  path: string;
}

export interface RemoteResourceLocation {
  scheme: "sftp";
  hostId: string;
  path: string;
}

export interface HttpResourceLocation {
  scheme: "http" | "https";
  url: string;
  domain: string;
}

export type DocumentLocation =
  | { scheme: "file"; path: string }
  | { scheme: "sftp"; hostId: string; path: string };

export interface LoadedResource {
  location: ResourceLocation;
  localPath: string;
  size: number;
  mimeType?: string;
  cacheHit: boolean;
}
