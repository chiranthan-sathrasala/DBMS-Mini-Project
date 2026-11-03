import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { del, get, put } from '@vercel/blob';
import { GridFSBucket } from 'mongodb';
import { ApiError } from '@/lib/api/errors';
import { mongoDb } from '@/lib/db/mongo';

/**
 * Local file storage (spec 16). Files live OUTSIDE public/, under random names, and are only ever
 * served through the authorised route /api/files/:versionId.
 */
export const ALLOWED_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  zip: 'application/zip',
};

export const baseDir = () => path.resolve(process.cwd(), process.env.STORAGE_LOCAL_PATH ?? './storage/uploads');
export const maxBytes = () => Number(process.env.STORAGE_MAX_FILE_MB ?? 10) * 1024 * 1024;
const useBlob = () => process.env.STORAGE_DRIVER === 'vercel-blob';
const useGridFS = () => process.env.STORAGE_DRIVER === 'mongodb-gridfs';

async function gridFS(): Promise<GridFSBucket> {
  return new GridFSBucket(await mongoDb(), { bucketName: 'uploads' });
}

async function putGridFS(key: string, bytes: Buffer): Promise<void> {
  const stream = (await gridFS()).openUploadStream(key);
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
    stream.end(bytes);
  });
}

const KEY_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)+$/;

/** Resolve a storage key to a path, refusing anything that could escape the storage folder. */
function safePath(key: string): string {
  if (!KEY_RE.test(key) || key.includes('..')) throw new ApiError(400, 'bad_path', 'Invalid file reference.');
  const full = path.resolve(baseDir(), key);
  if (!full.startsWith(baseDir() + path.sep)) throw new ApiError(400, 'bad_path', 'Invalid file reference.');
  return full;
}

/** Cheap content check so a renamed executable cannot pose as a PDF or image. */
function magicOk(ext: string, b: Buffer): boolean {
  const starts = (...bytes: number[]) => bytes.every((v, i) => b[i] === v);
  switch (ext) {
    case 'pdf': return starts(0x25, 0x50, 0x44, 0x46);
    case 'png': return starts(0x89, 0x50, 0x4e, 0x47);
    case 'jpg': return starts(0xff, 0xd8, 0xff);
    case 'zip': case 'docx': return starts(0x50, 0x4b);
    default: return !b.subarray(0, 4096).includes(0); // md / txt must be text (no NUL bytes)
  }
}

export interface StoredFile {
  key: string; fileName: string; size: number; checksum: string; mime: string; extractedText: string | null;
}

export function cleanFileName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ()]/g, '_').slice(0, 200);
  return base || 'upload';
}

export async function saveUpload(file: File): Promise<StoredFile> {
  const fileName = cleanFileName(file.name);
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  if (!ALLOWED_TYPES[ext]) {
    throw new ApiError(422, 'invalid_file', `File type .${ext || '?'} is not allowed. Allowed: ${Object.keys(ALLOWED_TYPES).join(', ')}.`, { file: 'Unsupported file type' });
  }
  if (file.size === 0) throw new ApiError(422, 'invalid_file', 'The file is empty.', { file: 'Empty file' });
  if (file.size > maxBytes()) {
    throw new ApiError(422, 'file_too_large', `The file is larger than ${process.env.STORAGE_MAX_FILE_MB ?? 10} MB.`, { file: 'File too large' });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!magicOk(ext, bytes)) {
    throw new ApiError(422, 'invalid_file', `The file content does not look like a .${ext} file.`, { file: 'Content does not match the file type' });
  }
  const now = new Date();
  const key = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${ext}`;
  if (useGridFS()) {
    await putGridFS(key, bytes);
  } else if (useBlob()) {
    await put(key, bytes, { access: 'private', addRandomSuffix: false, contentType: ALLOWED_TYPES[ext] });
  } else {
    const full = safePath(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, bytes, { mode: 0o640 });
  }
  const text = ext === 'md' || ext === 'txt' ? bytes.toString('utf8') : null;
  return {
    key, fileName, size: bytes.length, mime: ALLOWED_TYPES[ext],
    checksum: createHash('sha256').update(bytes).digest('hex'),
    extractedText: text && bytes.length <= 1_000_000 ? text.slice(0, 200_000) : null,
  };
}

/** Compensating action when a database step fails after the file was written. Never throws. */
export async function deleteStored(key: string | undefined | null): Promise<void> {
  if (!key || /^https?:/i.test(key)) return;
  try {
    if (useGridFS()) {
      const bucket = await gridFS();
      const file = await bucket.find({ filename: key }).next();
      if (file) await bucket.delete(file._id);
    } else if (useBlob()) await del(key);
    else await fs.unlink(safePath(key));
  } catch { /* already gone or compensating cleanup failed */ }
}

export async function readStored(key: string): Promise<Buffer> {
  if (useGridFS()) {
    const chunks: Buffer[] = [];
    for await (const chunk of (await gridFS()).openDownloadStreamByName(key)) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  if (useBlob()) {
    const result = await get(key, { access: 'private' });
    if (!result || result.statusCode !== 200) throw new Error('Stored file not found');
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }
  return fs.readFile(safePath(key));
}

/** Used by the seed: write demo content under seed/ so downloads work for seeded versions. */
export async function writeSeedFile(key: string, content: string): Promise<{ size: number; checksum: string }> {
  if (useGridFS()) {
    await putGridFS(key, Buffer.from(content));
  } else if (useBlob()) {
    await put(key, content, { access: 'private', addRandomSuffix: false, contentType: 'text/markdown; charset=utf-8' });
  } else {
    const full = safePath(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, { mode: 0o640 });
  }
  return { size: Buffer.byteLength(content), checksum: createHash('sha256').update(content).digest('hex') };
}
