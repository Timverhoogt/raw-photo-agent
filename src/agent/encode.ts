import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

/** JPEG bytes as base64, downscaled only when the long edge exceeds `maxEdge`. */
export async function encodePreview(path: string, maxEdge: number): Promise<string> {
  const bytes = await readFile(path);
  const { width = 0, height = 0 } = await sharp(bytes).metadata();
  if (Math.max(width, height) <= maxEdge) return bytes.toString('base64');
  const resized = await sharp(bytes).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 }).toBuffer();
  return resized.toString('base64');
}

/** Pulls a JSON object out of a reply that may wrap it in a Markdown code fence. */
export function extractJson(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return (fenced ? fenced[1]! : text).trim();
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
  } catch { return false; }
}
