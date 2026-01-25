import { BaseRepository } from "./base-repository";

export interface TekmetricTokenDocument {
  tokenKey: string;
  accessToken: string;
  tokenType: string;
  scope: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

class TekmetricTokenRepositoryImpl extends BaseRepository<TekmetricTokenDocument> {
  protected collectionName = "tekmetric_tokens";
  
  async getCurrentToken(): Promise<TekmetricTokenDocument | null> {
    return this.findOne({ tokenKey: "current" });
  }
  
  async upsertCurrentToken(token: Omit<TekmetricTokenDocument, "tokenKey" | "updatedAt">): Promise<boolean> {
    return this.upsertOne(
      { tokenKey: "current" } as any,
      {
        $set: {
          tokenKey: "current",
          accessToken: token.accessToken,
          tokenType: token.tokenType,
          scope: token.scope,
          expiresAt: token.expiresAt,
          createdAt: token.createdAt,
          updatedAt: new Date(),
        }
      } as any
    );
  }
  
  async deleteCurrentToken(): Promise<boolean> {
    return this.deleteOne({ tokenKey: "current" } as any);
  }
}

export const tekmetricTokenRepository = new TekmetricTokenRepositoryImpl();
