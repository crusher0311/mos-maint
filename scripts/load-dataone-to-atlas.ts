// scripts/load-dataone-to-atlas.ts
import 'dotenv/config';
import SftpClient from 'ssh2-sftp-client';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { MongoClient, type AnyBulkWriteOperation } from 'mongodb';

const {
  DATAONE_SFTP_HOST,
  DATAONE_SFTP_PORT = '22',
  DATAONE_SFTP_USER,
  DATAONE_SFTP_PASS,
  DATAONE_SFTP_REMOTE_DIR = '/outgoing',
  LOCAL_DOWNLOAD_DIR = './.dataone-cache',
  MONGODB_URI,
  MONGODB_DB = 'mos-maintenance-mvp',
} = process.env;

const DELIM = '|'; // adjust based on DataOne file layouts
const VEHICLES_FILENAME_PATTERN = /vehicles_.*\.txt$/i; // adjust to your actual file name(s)

type VehicleDoc = {
  _id: string;               // VIN or composite
  vin: string;
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  bodyStyle?: string;
  engine?: string;
  transmission?: string;
  fuelType?: string;
  driveType?: string;
  msrp?: number;
  updatedAt: Date;
  raw?: Record<string, string>; // keep raw columns for safety
};

function stableId(...parts: (string | number | undefined | null)[]) {
  return crypto.createHash('sha1').update(parts.filter(Boolean).join('::')).digest('hex');
}

async function ensureLocalDir(dir: string) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function sftpDownloadAll(pattern: RegExp) {
  const sftp = new SftpClient();
  await sftp.connect({
    host: DATAONE_SFTP_HOST!,
    port: Number(DATAONE_SFTP_PORT),
    username: DATAONE_SFTP_USER!,
    password: DATAONE_SFTP_PASS!,
  });

  const list = await sftp.list(DATAONE_SFTP_REMOTE_DIR!);
  const matches = list.filter(f => pattern.test(f.name));
  if (!matches.length) {
    console.warn('No matching files found on SFTP for pattern:', pattern);
  }

  await ensureLocalDir(LOCAL_DOWNLOAD_DIR!);
  const downloaded: string[] = [];
  for (const f of matches) {
    const localPath = path.join(LOCAL_DOWNLOAD_DIR!, f.name);
    await sftp.fastGet(path.posix.join(DATAONE_SFTP_REMOTE_DIR!, f.name), localPath);
    downloaded.push(localPath);
  }
  await sftp.end();
  return downloaded;
}

async function parseDelimitedFile(filePath: string): Promise<{ headers: string[]; rows: string[][] }> {
  const stream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let headers: string[] = [];
  const rows: string[][] = [];
  let lineNo = 0;

  for await (const line of rl) {
    const parts = line.split(DELIM);
    if (lineNo === 0) headers = parts.map(h => h.trim());
    else rows.push(parts);
    lineNo++;
  }
  return { headers, rows };
}

function rowToMap(headers: string[], row: string[]) {
  const m: Record<string, string> = {};
  headers.forEach((h, i) => { m[h] = (row[i] ?? '').trim(); });
  return m;
}

// Map a generic DataOne vehicles row into our VehicleDoc.
// Adjust field names to your exact DataOne headers.
function mapVehicle(doc: Record<string, string>): VehicleDoc | null {
  const vin = (doc['VIN'] || doc['vin'] || '').trim();
  if (!vin) return null;

  const num = (s: string) => (s && !Number.isNaN(Number(s)) ? Number(s) : undefined);

  return {
    _id: vin, // if VIN is unique; else use stableId(vin, year, make, model)
    vin,
    year: num(doc['Year'] || doc['year']),
    make: doc['Make'] || doc['make'],
    model: doc['Model'] || doc['model'],
    trim: doc['Trim'] || doc['trim'],
    bodyStyle: doc['BodyStyle'] || doc['body_style'] || doc['Style'],
    engine: doc['Engine'] || doc['engine_desc'],
    transmission: doc['Transmission'] || doc['trans_desc'],
    fuelType: doc['FuelType'] || doc['fuel_type'],
    driveType: doc['DriveType'] || doc['drive_type'],
    msrp: num(doc['MSRP'] || doc['msrp']),
    updatedAt: new Date(),
    raw: doc,
  };
}

async function loadVehiclesFile(client: MongoClient, filePath: string) {
  const { headers, rows } = await parseDelimitedFile(filePath);
  const col = client.db(MONGODB_DB).collection<VehicleDoc>('vehicles');

  const ops: AnyBulkWriteOperation<VehicleDoc>[] = [];
  for (const r of rows) {
    const mapped = mapVehicle(rowToMap(headers, r));
    if (!mapped) continue;
    ops.push({
      updateOne: {
        filter: { _id: mapped._id },
        update: { $set: mapped },
        upsert: true,
      },
    });
    if (ops.length >= 2000) { // batch for memory & speed
      await col.bulkWrite(ops, { ordered: false });
      ops.length = 0;
    }
  }
  if (ops.length) {
    await col.bulkWrite(ops, { ordered: false });
  }
}

async function main() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI not set');
  const client = new MongoClient(MONGODB_URI);
  await client.connect();

  // Ensure indexes (run repeatedly is safe)
  const col = client.db(MONGODB_DB).collection<VehicleDoc>('vehicles');
  await col.createIndex({ vin: 1 }, { unique: true, name: 'uniq_vin' });
  await col.createIndex({ make: 1, model: 1, year: -1 });
  await col.createIndex({ '$**': 'text' }, { name: 'text_all_fields' }); // optional general text

  const files = await sftpDownloadAll(VEHICLES_FILENAME_PATTERN);
  for (const f of files) {
    console.log('Loading', f);
    await loadVehiclesFile(client, f);
  }

  await client.close();
  console.log('Done.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
