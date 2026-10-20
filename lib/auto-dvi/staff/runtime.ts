import { staffAccess } from "./access";
import { StaffRepository } from "./store";
import { MongoStaffPersistence } from "@/lib/data/repositories/workflow-inspections";
import { readDispatchBoard, saveDispatchBoard } from "@/lib/data/repositories/shop-dispatch";
import type { StaffDependencies } from "./service";
import { ROArrivalPhotos } from "@/lib/data/repositories/ro-arrival-photos";
export const staffDependencies: StaffDependencies = {
  arrivalPhotos: new ROArrivalPhotos(),
  access: staffAccess, repository: new StaffRepository(new MongoStaffPersistence()),
  board: {read: readDispatchBoard, save: saveDispatchBoard}, now: () => new Date().toISOString(),
};
