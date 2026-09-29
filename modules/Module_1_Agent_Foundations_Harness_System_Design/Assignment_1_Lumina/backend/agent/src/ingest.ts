import type { Locator } from '@lumina/contract';
import { env } from './env.js';

/**
 * Parse and chunk: raw bytes in, citable chunks out. Pure functions, no database, so the
 * worker can re-run them on a retry and get exactly the same chunks (same text, same
 * order), which is what lets it skip the ones it already embedded.
 *
 * Every chunk carries ONE locator and never crosses it: a PDF chunk lives on one page, a
 * Markdown chunk under one heading, a text chunk starts at one line. That is what lets a
 * citation say `board-deck.pdf, p. 14` and be right.
 */

export interface Chunk {
  text: string;
  locator: Locator;
}

/** A run of source text that shares a locator, split into paragraphs with their line numbers. */
interface Section {
  locator: Locator;
  paragraphs: { text: string; line: number }[];
}

export interface Parsed {
  chunks: Chunk[];
  /** PDFs only: how many pages the file has. */
  pages?: number;
}

export async function parseAndChunk(bytes: Buffer, mimeType: string): Promise<Parsed> {
  if (mimeType === 'application/pdf') {
    const { sections, pages } = await pdfSections(bytes);
    return { chunks: sections.flatMap(chunkSection), pages };
  }
  const text = bytes.toString('utf8');
  const sections = mimeType === 'text/markdown' ? markdownSections(text) : textSections(text);
  return { chunks: sections.flatMap(chunkSection) };
}

// ---------------------------------------------------------------- parse

async function pdfSections(bytes: Buffer): Promise<{ sections: Section[]; pages: number }> {
  // The legacy build is the one that runs in Node without a DOM.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true })
    .promise;
  const sections: Section[] = [];
  try {
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str + (item.hasEOL ? '\n' : '');
      }
      // A page with no text (a scanned image, a blank page) simply contributes no chunks.
      const paragraphs = splitParagraphs(text, 1);
      if (paragraphs.length) sections.push({ locator: { page }, paragraphs });
    }
    return { sections, pages: pdf.numPages };
  } finally {
    await pdf.destroy();
  }
}

/** Each heading opens a section; text before the first heading is located by line. */
function markdownSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let heading: string | undefined;
  let start = 1;
  let buf: string[] = [];
  const flush = () => {
    const paragraphs = splitParagraphs(buf.join('\n'), start);
    if (paragraphs.length) sections.push({ locator: heading ? { heading } : { line: start }, paragraphs });
  };
  lines.forEach((line, i) => {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      heading = m[1];
      start = i + 1;
      buf = [line];
    } else {
      buf.push(line);
    }
  });
  flush();
  return sections;
}

function textSections(text: string): Section[] {
  const paragraphs = splitParagraphs(text.replace(/\r\n/g, '\n'), 1);
  return paragraphs.length ? [{ locator: { line: 1 }, paragraphs }] : [];
}

/** Blank-line-separated paragraphs, each with the line it starts on. */
function splitParagraphs(text: string, firstLine: number): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let buf: string[] = [];
  let start = 0;
  const flush = () => {
    if (buf.length) out.push({ text: buf.join('\n').trim(), line: firstLine + start });
    buf = [];
  };
  text.split('\n').forEach((l, i) => {
    if (!l.trim()) return flush();
    if (!buf.length) start = i;
    buf.push(l);
  });
  flush();
  return out;
}

// ---------------------------------------------------------------- chunk

/**
 * Pack paragraphs into chunks of about `chunkChars`, starting each new chunk with the tail
 * of the last one. Text files get the line the chunk starts on; PDF and Markdown chunks
 * keep their section's page or heading.
 */
function chunkSection(section: Section): Chunk[] {
  const max = env.chunkChars;
  const pieces = section.paragraphs.flatMap((p) => splitLong(p.text, max).map((text) => ({ text, line: p.line })));
  const locate = (line: number): Locator => (section.locator.line !== undefined ? { line } : section.locator);

  const chunks: Chunk[] = [];
  let text = '';
  let line = pieces[0]?.line ?? 1;
  for (const piece of pieces) {
    if (text && text.length + 2 + piece.text.length > max) {
      chunks.push({ text, locator: locate(line) });
      text = tail(text, env.chunkOverlapChars);
      line = piece.line;
    }
    text = text ? `${text}\n\n${piece.text}` : piece.text;
  }
  if (text) chunks.push({ text, locator: locate(line) });
  return chunks;
}

/** A paragraph longer than a chunk is cut at sentence ends, and failing that, at spaces. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'));
    const at = cut > max / 2 ? cut + 1 : window.lastIndexOf(' ') > max / 2 ? window.lastIndexOf(' ') : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** The last ~n characters, starting on a word boundary. */
function tail(text: string, n: number): string {
  if (n <= 0 || text.length <= n) return n <= 0 ? '' : text;
  const slice = text.slice(-n);
  const space = slice.indexOf(' ');
  return (space >= 0 ? slice.slice(space + 1) : slice).trim();
}
