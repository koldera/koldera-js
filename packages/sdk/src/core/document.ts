/** The structured document of `POST /v1/documents/jobs` (contracts/document.schema.json). Structure is declared, never inferred. */

export interface DocumentLink {
  text: string;
  url: string;
}

/** Running text: a plain string, strong text, emphasised text or a link. */
export type Inline = string | { strong: string } | { emphasis: string } | { link: DocumentLink };

export interface ListBody {
  ordered?: boolean;
  items: ListItem[];
}

/** Inline pieces, optionally followed by one nested list as the last element. */
export type ListItem = Array<Inline | { list: ListBody }>;

export interface HeadingBlock {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

export interface ParagraphBlock {
  type: "paragraph";
  content: Inline[];
  /** BCP 47 tag when it differs from the document language. */
  lang?: string;
  /** A bundled font name when it differs from the theme font. */
  font?: string;
}

export interface ListBlock extends ListBody {
  type: "list";
}

export interface TableBlock {
  type: "table";
  caption: string;
  /** At least one row with a non-blank cell; the first row sets the column count. */
  header: string[][];
  rows: string[][];
  rowHeaders?: boolean;
  columnAlign?: Array<"left" | "center" | "right">;
}

/** An image uploaded earlier (`uploads.upload` or `documents.uploadImage`), described or marked decorative. */
export type ImageBlock =
  | { type: "image"; uploadId: string; alt: string; decorative?: never }
  | { type: "image"; uploadId: string; decorative: true; alt?: never };

export interface LinkBlock {
  type: "link";
  text: string;
  url: string;
}

export interface PageBreakBlock {
  type: "pageBreak";
}

export interface SpacerBlock {
  type: "spacer";
  /** A length with a unit: mm, cm, in or pt, for example `8mm`. */
  height: string;
}

export interface KeyValueBlock {
  type: "keyValue";
  rows: Array<[label: string, value: string]>;
}

export interface PageNumberBlock {
  type: "pageNumber";
}

export type Block = HeadingBlock | ParagraphBlock | ListBlock | TableBlock | ImageBlock | LinkBlock | PageBreakBlock | SpacerBlock | KeyValueBlock;
export type FooterBlock = Block | PageNumberBlock;

export interface DocumentPage {
  size?: "A4" | "A5" | "Letter" | "Legal";
  orientation?: "portrait" | "landscape";
  /** A length with a unit, for example `20mm`. */
  margins?: string;
}

export interface DocumentTheme {
  font?: string;
  /** Points, 6-24. */
  fontSize?: number;
  /** `#rrggbb`. */
  accent?: string;
}

export interface StructuredDocument {
  title: string;
  /** BCP 47 tag, for example `en` or `uk`. */
  language: string;
  page?: DocumentPage;
  theme?: DocumentTheme;
  header?: Block[];
  footer?: FooterBlock[];
  body: Block[];
}
