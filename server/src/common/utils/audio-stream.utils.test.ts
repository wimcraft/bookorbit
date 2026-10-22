import { audioMimeType, parseByteRange } from './audio-stream.utils';

describe('parseByteRange', () => {
  it('treats a missing or unusable header as a full response', () => {
    expect(parseByteRange(undefined, 1000)).toBeNull();
    expect(parseByteRange('', 1000)).toBeNull();
    expect(parseByteRange('bytes=-', 1000)).toBeNull();
    expect(parseByteRange('items=0-5', 1000)).toBeNull();
    expect(parseByteRange('bytes=0-5,10-20', 1000)).toBeNull();
  });

  it('resolves open ended and bounded ranges', () => {
    expect(parseByteRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseByteRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 });
    expect(parseByteRange('bytes=999-999', 1000)).toEqual({ start: 999, end: 999 });
  });

  it('clamps an end past the file instead of refusing the request', () => {
    expect(parseByteRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange('bytes=0-1048575', 500)).toEqual({ start: 0, end: 499 });
  });

  it('serves the tail for a suffix range', () => {
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('marks ranges outside the file as unsatisfiable', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=500-100', 1000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
  });
});

describe('audioMimeType', () => {
  it('maps known formats and falls back to octet-stream', () => {
    expect(audioMimeType('M4B')).toBe('audio/mp4');
    expect(audioMimeType('mp3')).toBe('audio/mpeg');
    expect(audioMimeType('wav')).toBe('application/octet-stream');
  });
});
