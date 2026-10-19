/**
 * A transaction-scoped advisory lock limits this lane to one report across all
 * processes sharing the reporting database. No app-local semaphore or lease.
 * Settings/permission failures abort the transaction; never retry unguarded.
 */
export async function admitInvoiceFleet(query:(text:string,params:unknown[])=>PromiseLike<any[]>){
  await query("SET TRANSACTION READ ONLY",[]);
  await query("SET LOCAL work_mem='2MB'",[]);
  await query("SET LOCAL hash_mem_multiplier=1",[]);
  await query("SET LOCAL temp_file_limit='64MB'",[]);
  await query("SET LOCAL max_parallel_workers_per_gather=0",[]);
  await query("SET LOCAL lock_timeout='1s'",[]);
  await query("SET LOCAL idle_in_transaction_session_timeout='5s'",[]);
  const rows=await query("SELECT pg_try_advisory_xact_lock(19470221,1) AS admitted",[]);
  if(rows.length!==1||rows[0].admitted!==true)
    throw Error("Another fleet invoice report is running. Please retry shortly.");
}
