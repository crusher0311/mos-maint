import postgres from "postgres";
import { InvoiceFence } from "./fence";
import { guardPostgres } from "./guarded-drivers";

/**
 * Production/script factory. Both pools use the exact same caller-supplied
 * endpoint; a production CLI must not fence a different development database.
 * No credentials, connection strings or row data are logged.
 */
const fencedPostgres: typeof postgres = ((...args: any[]) => {
  const client = (postgres as any)(...args);
  const coordinatorArgs = typeof args[0] === "string"
    ? [args[0], { ...args[1], max: 2, idle_timeout: 20 }]
    : [{ ...args[0], max: 2, idle_timeout: 20 }];
  const coordinator = (postgres as any)(...coordinatorArgs);
  const guarded = guardPostgres(client, new InvoiceFence(coordinator));
  const end = client.end.bind(client);
  client.end = async (...options: any[]) => {
    await end(...options);
    await coordinator.end(...options);
  };
  return guarded;
}) as typeof postgres;
export default fencedPostgres;
export { fencedPostgres };
