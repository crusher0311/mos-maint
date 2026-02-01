import sql from "@/lib/db/postgres";

export async function getNextShopId(): Promise<number> {
  const result = await sql`
    INSERT INTO counters (name, seq)
    VALUES ('shopId', 1)
    ON CONFLICT (name) DO UPDATE SET seq = counters.seq + 1
    RETURNING seq
  `;

  const seq = result[0]?.seq;

  if (!Number.isFinite(seq)) {
    throw new Error("Counter not initialized correctly");
  }
  
  return seq as number;
}
