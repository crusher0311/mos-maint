import {createHash} from "node:crypto";
import {GridFSBucket, ObjectId, type Db} from "mongodb";
import {getDb} from "../../data/db";
import {requireThat} from "../../shop-dispatch/model";
import {RECORDING_LIMITS} from "./recording-model";

const bucketName = "workflow_staff_recording_media";
export type RecordingMediaOwner = {shopId: number; visitId: string; recordingId: string; actor: string};
export const recordingMediaDigest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function validateBytes(bytes: Buffer, mime: string) {
  requireThat(bytes.length > 0 && bytes.length <= RECORDING_LIMITS.segmentBytes, "Recording segment exceeds 4 MiB", 413);
  const webm = bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const mp4 = bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp";
  requireThat((["video/webm", "audio/webm"].includes(mime) && webm) ||
    (["video/mp4", "audio/mp4"].includes(mime) && mp4), "Unsupported recording container", 400);
}
/** Each physical attempt gets a fresh GridFS identity: concurrent/restarted
 * uploads never append chunks to another attempt. Unreferenced files are private
 * orphans, not successful receipts; cleanup must not remove referenced media. */
export class RecordingMediaStorage {
  constructor(private database: () => Promise<Db> = getDb) {}
  async upload(owner: RecordingMediaOwner, bytes: Buffer, mime: string, silentDerivative = false) {
    validateBytes(bytes, mime);
    const db = await this.database(), id = new ObjectId(), digest = recordingMediaDigest(bytes);
    const bucket = new GridFSBucket(db, {bucketName, writeConcern: {w: "majority", wtimeoutMS: 5000}});
    const upload = bucket.openUploadStreamWithId(id, "private-inspection-segment", {
      metadata: {...owner, mime, digest, silentDerivative, createdAt: new Date()},
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => upload.destroy(Error("Recording upload deadline exceeded")), 10_000);
      upload.once("error", error => {clearTimeout(timer); reject(error);});
      upload.once("finish", () => {clearTimeout(timer); resolve();});
      upload.end(bytes);
    });
    return {id: id.toHexString(), digest, bytes: bytes.length, mime};
  }
  async readReleased(id: string, shopId: number, visitId: string) {
    requireThat(/^[a-f0-9]{24}$/.test(id), "Released media unavailable", 404);
    const db = await this.database();
    const row = await db.collection(`${bucketName}.files`).findOne({_id: new ObjectId(id),
      "metadata.shopId": shopId, "metadata.visitId": visitId, "metadata.silentDerivative": true,
      "metadata.mime": "video/mp4"}, {maxTimeMS: 2000});
    requireThat(row, "Released media unavailable", 404);
    return this.read({shopId, visitId, recordingId: row.metadata.recordingId, actor: row.metadata.actor}, id, row.metadata.digest);
  }
  async read(owner: RecordingMediaOwner, id: string, expectedDigest: string) {
    requireThat(/^[a-f0-9]{24}$/.test(id), "Recording media not found", 404);
    const db = await this.database(), _id = new ObjectId(id);
    const file = await db.collection(`${bucketName}.files`).findOne({_id,
      "metadata.shopId": owner.shopId, "metadata.visitId": owner.visitId,
      "metadata.recordingId": owner.recordingId, "metadata.actor": owner.actor,
      "metadata.digest": expectedDigest}, {maxTimeMS: 2000});
    requireThat(file && file.length > 0 && file.length <= RECORDING_LIMITS.segmentBytes, "Recording media not found", 404);
    const stream = new GridFSBucket(db, {bucketName}).openDownloadStream(_id), parts: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => stream.destroy(Error("Recording read deadline exceeded")), 10_000);
    try {
      for await (const part of stream) {
        total += part.length;
        requireThat(total <= RECORDING_LIMITS.segmentBytes, "Recording data exceeds its receipt", 409);
        parts.push(Buffer.from(part));
      }
    } finally {clearTimeout(timer); stream.destroy();}
    const bytes = Buffer.concat(parts);
    requireThat(bytes.length === file.length && recordingMediaDigest(bytes) === expectedDigest, "Recording data failed receipt verification", 409);
    return {bytes, mime: String(file.metadata!.mime)};
  }
}
