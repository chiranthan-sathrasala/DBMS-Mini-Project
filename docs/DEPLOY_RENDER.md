# Render deployment

The `render.yaml` Blueprint deploys the entire Next.js frontend and API as one free Render web service in Singapore. PostgreSQL with pgvector is hosted on Neon. MongoDB and uploaded files are hosted on MongoDB Atlas; files use GridFS (`STORAGE_DRIVER=mongodb-gridfs`), so Render restarts do not erase them.

1. Import this repository as a Render Blueprint and select the `projectpulse-dbms` service. Use the free plan in `render.yaml`.
2. Set `DATABASE_URL` to the **direct** Neon connection string for the `pp_app` role. The app sets `search_path` at connection startup, which Neon pooler does not support.
3. Set `MONGODB_URI` to the Atlas Node.js driver connection string for an application database user. Keep the value private.
4. In the Render service, open **Connect → Outbound** and copy every published IP range for this service. Add only those ranges to the Atlas project's **Database & Network Access → IP Access List**. Keep the existing local IP entry if local maintenance is needed. Do not add `0.0.0.0/0`.
5. Deploy and verify `/login`, sign-in, dashboard data, document download, and an upload. The Blueprint generates `AUTH_SECRET` and `JOB_SECRET` and sets `MONGODB_DB`, `STORAGE_DRIVER`, and `STORAGE_MAX_FILE_MB`.

Run migrations and the initial seed from a trusted machine with direct Neon and Atlas connections. After the SQL seed, place the direct Neon app URI and Atlas URI in the ignored local `.env.hosted` file and run `npm run mongo:seed-hosted` to upload the seed files to GridFS and build the MongoDB documents. The command is safe to rerun; it skips files already present in GridFS. The hosted SQL database already has the schema and demo data.

Render's free web service sleeps when idle and has an ephemeral local filesystem. New requests after idle may be slow. Atlas GridFS keeps uploaded files outside that filesystem. The embedding model is downloaded on demand after a cold start; the seeded proposal vectors remain in Neon.
