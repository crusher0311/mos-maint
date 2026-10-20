import { MongoClient as NativeMongoClient, type Db, type DbOptions, type ClientSessionOptions } from "mongodb";
import { invoiceFence } from "./runtime";
import { guardMongoDb } from "./guarded-drivers";
export * from "mongodb";

/** Direct tooling must use the same mandatory Db boundary as app repositories.
 * Client-level bulk operations are refused rather than bypassing Db guards. */
export class MongoClient extends NativeMongoClient {
  override db(name?: string, options?: DbOptions): Db {
    return guardMongoDb(super.db(name, options), invoiceFence());
  }
  override startSession(options?: ClientSessionOptions) {
    const session = super.startSession(options);
    const fence = invoiceFence();
    const start = session.startTransaction.bind(session);
    const transaction = session.withTransaction.bind(session);
    session.startTransaction = (...args) => {
      if (!fence.isScoped()) throw Error("Mongo transactions require a whole-operation invoice fence");
      return start(...args);
    };
    session.withTransaction = ((...args: any[]) => fence.run(() => (transaction as any)(...args))) as typeof session.withTransaction;
    return session;
  }
  override bulkWrite: NativeMongoClient["bulkWrite"] = (..._args: any[]) => {
    throw Error("Use fenced collection bulkWrite, not unscoped client bulkWrite");
  };
  override watch: NativeMongoClient["watch"] = (..._args: any[]) => {
    throw Error("Client change streams are outside the repair boundary");
  };
}
