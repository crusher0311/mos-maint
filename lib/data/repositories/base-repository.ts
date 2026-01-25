import { Collection, Db, Filter, FindOptions, UpdateFilter, UpdateOptions, Document, OptionalUnlessRequiredId, WithId } from "mongodb";
import { getDb } from "@/lib/mongo";
import { withQueryMonitoring } from "@/lib/query-monitor";

export abstract class BaseRepository<T extends Document> {
  protected abstract collectionName: string;
  
  protected async getCollection(): Promise<Collection<T>> {
    const db = await getDb();
    return db.collection<T>(this.collectionName);
  }
  
  async findOne(filter: Filter<T>): Promise<WithId<T> | null> {
    return withQueryMonitoring(this.collectionName, 'findOne', async () => {
      const collection = await this.getCollection();
      return collection.findOne(filter);
    });
  }
  
  async findMany(filter: Filter<T>, options?: FindOptions<T>): Promise<WithId<T>[]> {
    return withQueryMonitoring(this.collectionName, 'findMany', async () => {
      const collection = await this.getCollection();
      return collection.find(filter, options).toArray();
    });
  }
  
  async insertOne(doc: OptionalUnlessRequiredId<T>): Promise<string> {
    return withQueryMonitoring(this.collectionName, 'insertOne', async () => {
      const collection = await this.getCollection();
      const result = await collection.insertOne(doc);
      return result.insertedId.toString();
    });
  }
  
  async updateOne(
    filter: Filter<T>,
    update: UpdateFilter<T>,
    options?: UpdateOptions
  ): Promise<boolean> {
    return withQueryMonitoring(this.collectionName, 'updateOne', async () => {
      const collection = await this.getCollection();
      const result = await collection.updateOne(filter, update, options);
      return result.modifiedCount > 0 || result.upsertedCount > 0;
    });
  }
  
  async upsertOne(
    filter: Filter<T>,
    update: UpdateFilter<T>
  ): Promise<boolean> {
    return this.updateOne(filter, update, { upsert: true });
  }
  
  async deleteOne(filter: Filter<T>): Promise<boolean> {
    return withQueryMonitoring(this.collectionName, 'deleteOne', async () => {
      const collection = await this.getCollection();
      const result = await collection.deleteOne(filter);
      return result.deletedCount > 0;
    });
  }
  
  async count(filter: Filter<T>): Promise<number> {
    const collection = await this.getCollection();
    return collection.countDocuments(filter);
  }
  
  async exists(filter: Filter<T>): Promise<boolean> {
    const count = await this.count(filter);
    return count > 0;
  }
}
