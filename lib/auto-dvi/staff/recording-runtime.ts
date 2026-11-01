import {staffDependencies} from "./runtime";
import {RecordingRepository, MongoRecordingPersistence} from "./recording-store";
import {RecordingMediaStorage} from "./recording-media";
import type {RecordingDependencies} from "./recording-service";

export const recordingDependencies: RecordingDependencies = {
  staff: staffDependencies, repository: new RecordingRepository(new MongoRecordingPersistence()),
};
export const recordingMedia = new RecordingMediaStorage();
