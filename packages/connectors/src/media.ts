import { ConnectorError } from './http.ts';
export function assertMediaBytes(bytes: Uint8Array, mime: string, maxBytes = 20 * 1024 * 1024) {
  if (!bytes.length || bytes.length > maxBytes) throw new ConnectorError('INVALID_MEDIA_SIZE');
  const b = Buffer.from(bytes), ascii = (start: number, end: number) => b.subarray(start, end).toString('ascii');
  const valid = mime === 'image/png' ? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'image/jpeg' ? b.length > 3 && b[0] === 255 && b[1] === 216 && b[2] === 255
    : mime === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
    : mime === 'image/webp' ? ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
    : mime === 'image/avif' ? ascii(4, 8) === 'ftyp' && /^(avif|avis)$/.test(ascii(8, 12))
    : mime === 'video/mp4' ? ascii(4, 8) === 'ftyp' && /^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV)$/.test(ascii(8, 12))
    : false;
  if (!valid) throw new ConnectorError('MEDIA_TYPE_MISMATCH');
}
