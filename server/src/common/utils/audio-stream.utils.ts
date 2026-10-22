import { createReadStream } from 'node:fs';
import { basename } from 'node:path';

import type { FastifyReply } from 'fastify';

import { contentDispositionHeader } from './content-disposition.utils';

export const AUDIO_MIME_TYPES: Record<string, string> = {
  m4b: 'audio/mp4',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  opus: 'audio/ogg; codecs=opus',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

export function audioMimeType(format: string): string {
  return AUDIO_MIME_TYPES[format.toLowerCase()] ?? 'application/octet-stream';
}

export interface AudioStreamSource {
  absolutePath: string;
  format: string;
  sizeBytes: number;
}

export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * Resolves a single `Range` header against a file size. A null result means the header is absent or
 * not a single byte range, which is served as a full response. An end past the file is clamped, as
 * RFC 9110 requires, because players routinely ask for a fixed window larger than a short track.
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (size <= 0) return 'unsatisfiable';

  if (match[1] === '') {
    const suffixLength = Number.parseInt(match[2]!, 10);
    if (suffixLength <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number.parseInt(match[1]!, 10);
  const requestedEnd = match[2] === '' ? size - 1 : Number.parseInt(match[2]!, 10);
  if (start >= size || requestedEnd < start) return 'unsatisfiable';
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export function sendAudioFile(
  reply: FastifyReply,
  source: AudioStreamSource,
  rangeHeader: string | undefined,
  disposition: 'inline' | 'attachment' = 'inline',
): void {
  const size = source.sizeBytes;
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Disposition', contentDispositionHeader(disposition, basename(source.absolutePath), 'audiobook'));
  reply.type(audioMimeType(source.format));

  const range = parseByteRange(rangeHeader, size);
  if (range === 'unsatisfiable') {
    reply.status(416).header('Content-Range', `bytes */${size}`).send();
    return;
  }
  if (range) {
    reply.status(206);
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    reply.header('Content-Length', range.end - range.start + 1);
    reply.send(createReadStream(source.absolutePath, { start: range.start, end: range.end }));
    return;
  }

  reply.header('Content-Length', size);
  reply.send(createReadStream(source.absolutePath));
}
