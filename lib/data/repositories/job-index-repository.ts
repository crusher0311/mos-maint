import { BaseRepository } from "./base-repository";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongo";

export interface JobIndexDocument {
  _id?: ObjectId;
  shopId: number;
  jobName: string;
  jobNameLower: string;
  laborCodes?: string[];
  partNumbers?: string[];
  vehicleInfo?: {
    year?: number;
    make?: string;
    model?: string;
    vin?: string;
  };
  repairOrderId?: string | number;
  workOrderId?: string | number;
  completedAt?: Date;
  totalAmount?: number;
  laborAmount?: number;
  partsAmount?: number;
  source?: "protractor" | "tekmetric" | "autoflow";
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PartCrossRefDocument {
  _id?: ObjectId;
  shopId: number;
  partNumber: string;
  partNumberLower: string;
  description?: string;
  jobNames?: string[];
  vehicleInfo?: {
    year?: number;
    make?: string;
    model?: string;
  };
  lastUsedAt?: Date;
  usageCount?: number;
  source?: "protractor" | "tekmetric" | "autoflow";
  createdAt?: Date;
  updatedAt?: Date;
}

class JobIndexRepositoryImpl extends BaseRepository<JobIndexDocument> {
  protected collectionName = "job_index";
  
  async searchJobs(
    shopId: number,
    query: string,
    options?: { limit?: number; vehicleFilter?: { year?: number; make?: string; model?: string } }
  ): Promise<JobIndexDocument[]> {
    const collection = await this.getCollection();
    const filter: Record<string, unknown> = {
      shopId,
      jobNameLower: { $regex: query.toLowerCase(), $options: "i" }
    };
    
    if (options?.vehicleFilter) {
      if (options.vehicleFilter.year) filter["vehicleInfo.year"] = options.vehicleFilter.year;
      if (options.vehicleFilter.make) filter["vehicleInfo.make"] = options.vehicleFilter.make;
      if (options.vehicleFilter.model) filter["vehicleInfo.model"] = options.vehicleFilter.model;
    }
    
    return collection
      .find(filter)
      .sort({ completedAt: -1 })
      .limit(options?.limit || 50)
      .toArray();
  }
  
  async upsertJob(job: Omit<JobIndexDocument, "_id">): Promise<boolean> {
    return this.upsertOne(
      { 
        shopId: job.shopId, 
        jobName: job.jobName,
        repairOrderId: job.repairOrderId 
      },
      { 
        $set: { ...job, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() }
      }
    );
  }
  
  async bulkUpsertJobs(jobs: Omit<JobIndexDocument, "_id">[]): Promise<number> {
    if (jobs.length === 0) return 0;
    
    const collection = await this.getCollection();
    const operations = jobs.map(job => ({
      updateOne: {
        filter: { 
          shopId: job.shopId, 
          jobName: job.jobName,
          repairOrderId: job.repairOrderId 
        },
        update: { 
          $set: { ...job, updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() }
        },
        upsert: true
      }
    }));
    
    const result = await collection.bulkWrite(operations);
    return result.upsertedCount + result.modifiedCount;
  }
  
  async getJobsByShop(shopId: number, limit = 100): Promise<JobIndexDocument[]> {
    return this.findMany(
      { shopId },
      { sort: { completedAt: -1 }, limit }
    );
  }
  
  async deleteByShop(shopId: number): Promise<number> {
    const collection = await this.getCollection();
    const result = await collection.deleteMany({ shopId });
    return result.deletedCount;
  }
}

class PartCrossRefRepositoryImpl extends BaseRepository<PartCrossRefDocument> {
  protected collectionName = "part_cross_ref";
  
  async searchParts(
    shopId: number,
    query: string,
    limit = 50
  ): Promise<PartCrossRefDocument[]> {
    const collection = await this.getCollection();
    return collection
      .find({
        shopId,
        $or: [
          { partNumberLower: { $regex: query.toLowerCase(), $options: "i" } },
          { description: { $regex: query, $options: "i" } }
        ]
      })
      .sort({ usageCount: -1 })
      .limit(limit)
      .toArray();
  }
  
  async upsertPart(part: Omit<PartCrossRefDocument, "_id">): Promise<boolean> {
    return this.upsertOne(
      { shopId: part.shopId, partNumber: part.partNumber },
      { 
        $set: { ...part, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
        $inc: { usageCount: 1 }
      }
    );
  }
  
  async bulkUpsertParts(parts: Omit<PartCrossRefDocument, "_id">[]): Promise<number> {
    if (parts.length === 0) return 0;
    
    const collection = await this.getCollection();
    const operations = parts.map(part => ({
      updateOne: {
        filter: { shopId: part.shopId, partNumber: part.partNumber },
        update: { 
          $set: { ...part, updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() },
          $inc: { usageCount: 1 }
        },
        upsert: true
      }
    }));
    
    const result = await collection.bulkWrite(operations);
    return result.upsertedCount + result.modifiedCount;
  }
}

export const jobIndexRepository = new JobIndexRepositoryImpl();
export const partCrossRefRepository = new PartCrossRefRepositoryImpl();
