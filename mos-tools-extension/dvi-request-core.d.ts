export interface DviContext {
  durable: boolean; scopeKey: string; workOrderGuid: string; vin: string;
  operation?: {operationId?: string; operationState?: string} | null;
}
export const warning: string;
export function read(storage: Storage, context: DviContext): {clientRequestId: string; revision: string} | null;
export function prepare(storage: Storage, context: DviContext, draft: object): Promise<object>;
