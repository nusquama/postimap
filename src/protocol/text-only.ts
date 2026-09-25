import { randomBytes } from "node:crypto";
import type { MessageStructureObject } from "imapflow";

/**
 * storage.attachments = on_demand: a message is mirrored from its headers and its text
 * parts only. Attachment bytes stay on the server and are fetched by part number when
 * asked for (see attachment-download.ts).
 *
 * The text still goes through the same MIME parser as a full message, so body_text and
 * body_html come out exactly as they would from the whole source: the message is rebuilt
 * with its original headers and MIME tree, the text parts carrying their real content and
 * every attachment an empty body.
 */

export interface PlannedAttachment {
  part: string;
  filename: string | null;
  contentType: string;
  contentId: string | null;
  /** Decoded size, estimated from the encoded size the server reports. */
  size: number;
}

export interface PartPlan {
  /** Parts whose content is fetched: text/plain and text/html that are not attachments. */
  textParts: string[];
  /** Encoded size of the text parts, what fetching them costs. */
  textBytes: number;
  attachments: PlannedAttachment[];
}

const TEXT_TYPES = new Set(["text/plain", "text/html"]);

/** BODYSTRUCTURE numbering: a message that is not multipart has a single part, "1". */
function partNumber(node: MessageStructureObject): string {
  return node.part ?? "1";
}

function isMultipart(node: MessageStructureObject): boolean {
  return node.type.startsWith("multipart/") && (node.childNodes?.length ?? 0) > 0;
}

function isBodyText(node: MessageStructureObject): boolean {
  return TEXT_TYPES.has(node.type) && node.disposition !== "attachment";
}

function decodedSize(node: MessageStructureObject): number {
  const size = node.size ?? 0;
  return node.encoding?.toLowerCase() === "base64" ? Math.floor((size * 3) / 4) : size;
}

export function planParts(structure: MessageStructureObject): PartPlan {
  const plan: PartPlan = { textParts: [], textBytes: 0, attachments: [] };

  const visit = (node: MessageStructureObject): void => {
    // An attached message/rfc822 is one attachment, not more body to read.
    if (isMultipart(node)) {
      for (const child of node.childNodes ?? []) visit(child);
      return;
    }
    if (isBodyText(node)) {
      plan.textParts.push(partNumber(node));
      plan.textBytes += node.size ?? 0;
      return;
    }
    plan.attachments.push({
      part: partNumber(node),
      filename: node.dispositionParameters?.filename ?? node.parameters?.name ?? null,
      contentType: node.type,
      contentId: node.id ?? null,
      size: decodedSize(node),
    });
  };

  visit(structure);
  return plan;
}

/** A MIME parameter value, always quoted. */
function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/** Headers for a text part, from what BODYSTRUCTURE reports -- all ASCII by construction. */
function textPartHeaders(node: MessageStructureObject): string {
  const params = Object.entries(node.parameters ?? {})
    .filter(([key]) => key === "charset" || key === "format" || key === "delsp")
    .map(([key, value]) => `; ${key}=${quote(value)}`)
    .join("");
  const lines = [`Content-Type: ${node.type}${params}`];
  if (node.encoding) lines.push(`Content-Transfer-Encoding: ${node.encoding}`);
  if (node.disposition) lines.push(`Content-Disposition: ${node.disposition}`);
  return lines.join("\r\n");
}

/** An attachment stands in with its type and no content; the parser leaves it out of the text. */
function attachmentHeaders(node: MessageStructureObject): string {
  const type = node.type.startsWith("message/") ? "application/octet-stream" : node.type;
  return `Content-Type: ${type}\r\nContent-Disposition: attachment`;
}

function boundary(): string {
  return `postimap-${randomBytes(12).toString("hex")}`;
}

/** The part's content headers followed by its body, as bytes (latin1 keeps them untouched). */
function renderNode(node: MessageStructureObject, contents: Map<string, Buffer>): string {
  if (isMultipart(node)) {
    const b = boundary();
    const children = (node.childNodes ?? [])
      .map((child) => `--${b}\r\n${renderNode(child, contents)}\r\n`)
      .join("");
    return `Content-Type: ${node.type}; boundary=${quote(b)}\r\n\r\n${children}--${b}--`;
  }
  if (isBodyText(node)) {
    const body = contents.get(partNumber(node))?.toString("latin1") ?? "";
    return `${textPartHeaders(node)}\r\n\r\n${body}`;
  }
  return `${attachmentHeaders(node)}\r\n\r\n`;
}

const CONTENT_HEADERS = /^(content-type|content-transfer-encoding|content-disposition):/i;

/** The top-level header block minus the content headers the rebuilt body replaces. */
function stripContentHeaders(headerBlock: Buffer): string {
  const lines = headerBlock.toString("latin1").split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line === "") break;
    const continuation = /^[ \t]/.test(line);
    if (!continuation) skipping = CONTENT_HEADERS.test(line);
    if (!skipping) kept.push(line);
  }
  return kept.join("\r\n");
}

/**
 * The message rebuilt from its header block (BODY[HEADER]), its BODYSTRUCTURE and the raw,
 * still transfer-encoded content of its text parts (BODY[part]).
 */
export function rebuildTextOnlySource(
  headerBlock: Buffer,
  structure: MessageStructureObject,
  contents: Map<string, Buffer>,
): Buffer {
  const headers = stripContentHeaders(headerBlock);
  // No trailing CRLF: a single-part body from BODY[1] already ends the way the original did.
  return Buffer.from(`${headers}\r\n${renderNode(structure, contents)}`, "latin1");
}
