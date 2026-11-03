import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { Client } from 'pg';
import { GridFSBucket, MongoClient } from 'mongodb';
import { baseDir, writeSeedFile } from '../src/lib/storage';
import { seedMongo } from '../db/seeds/mongo';

/** Complete the hosted Mongo seed after SQL has already been seeded locally. */
async function main() {
  dotenv.config({ path: '.env.hosted', override: true });
  const pgUri = process.env.DATABASE_URL;
  const mongoUri = process.env.MONGODB_URI;
  if (!pgUri || !mongoUri?.startsWith('mongodb+srv://')) {
    throw new Error('Set hosted DATABASE_URL and MONGODB_URI in ignored .env.hosted first.');
  }
  const pg = new Client({ connectionString: pgUri });
  const mongo = new MongoClient(mongoUri);
  await pg.connect();
  try {
    await mongo.connect();
    await pg.query('SET search_path = projectpulse, public');
    const db = mongo.db(process.env.MONGODB_DB ?? 'projectpulse');
    const bucket = new GridFSBucket(db, { bucketName: 'uploads' });
    const { rows } = await pg.query<{ file_url: string }>('SELECT file_url FROM document_versions ORDER BY version_id');
    let uploaded = 0;
    process.env.STORAGE_DRIVER = 'mongodb-gridfs';
    for (const { file_url: key } of rows) {
      if (await bucket.find({ filename: key }).next()) continue;
      const content = await fs.readFile(path.join(baseDir(), key), 'utf8');
      await writeSeedFile(key, content);
      uploaded++;
    }
    process.env.STORAGE_DRIVER = 'local';
    const result = await seedMongo(pg, mongoUri, process.env.MONGODB_DB ?? 'projectpulse');
    console.log(`Uploaded ${uploaded} seed files to Atlas GridFS; seeded ${result.documents} documents and ${result.threads} threads.`);
  } finally {
    await pg.end();
    await mongo.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
