import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
export const random = () => randomBytes(32).toString('base64url');
export const hash = (value: string) =>
  createHash('sha256').update(value).digest('base64url');
export function seal(key: Buffer, value: unknown, context: string): string {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), body]
    .map((b) => b.toString('base64url'))
    .join('.');
}
export function unseal<T>(key: Buffer, value: string, context: string): T {
  const [iv, tag, body] = value
    .split('.')
    .map((s) => Buffer.from(s, 'base64url'));
  if (!iv || !tag || !body) throw new Error('invalid_envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'),
  ) as T;
}
