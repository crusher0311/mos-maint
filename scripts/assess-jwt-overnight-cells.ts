/** Read-only location/month triage. Count differences are NOT identity proof. */
import postgres from "postgres";
import {readFileSync,writeFileSync} from "node:fs";
import {getEnterpriseByShopId} from "../lib/enterprise";
import {getMongoClient} from "../lib/mongo";
async function main(){
 const e=await getEnterpriseByShopId(227);
 if(e?.name!=="JWT")throw Error("Membership unresolved");
 const native=JSON.parse(readFileSync("docs/reporting/jwt-native-export-assessment.json","utf8"));
 const cells=native.cells.filter((c:any)=>c.type==="Invoice"&&["2026-08","2026-09"].includes(c.month));
 if(cells.length!==20)throw Error("Expected 20 native baseline cells");
 const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:10,
 connection:{options:"-c default_transaction_read_only=on -c statement_timeout=5000 -c timezone=UTC"}});
 const output:any[]=[];
 try{for(const c of cells){
 const shopId=Number(c.location)-474;
 if(!e.shopIds.some(id=>Number(id)===shopId))throw Error("Native shop outside enterprise");
 const end=c.month==="2026-08"?"2026-09-01":"2026-10-01";
 try{
 const [r]=await pg.unsafe(`SELECT count(*)::int stored,coalesce(sum(labor_total),0)::text header_labor,
 count(*) FILTER (WHERE labor_total=0)::int zero_labor
 FROM normalized_work_orders WHERE shop_id=$1 AND coalesce(closed_date,completed_date)>=$2
 AND coalesce(closed_date,completed_date)<$3 AND status IN ('closed','invoiced','paid')
 AND NOT coalesce((soft_delete->>'isDeleted')::boolean,false)`,[shopId,c.month+"-01",end]);
 output.push({location:c.location,shopId,month:c.month,nativeInvoices:c.distinct_work_order_numbers,
 storedTerminalROs:r.stored,netCountShortfall:c.distinct_work_order_numbers-r.stored,
 nativeLabor:Number(c.raw_package_sums["Labor Total"]),storedHeaderLabor:Number(r.header_labor),storedZeroLabor:r.zero_labor});
 }catch(err:any){output.push({location:c.location,shopId,month:c.month,unavailable:true,error:err.code??err.name});}
 }
 }finally{await pg.end({timeout:5});}
 const report={checkedAt:new Date().toISOString(),readOnly:true,
 limitation:"Counts use UTC business dates; native date timezone remains unconfirmed. Counts alone do not identify missing invoices, resolve credits, or authorize writes.",cells:output};
 writeFileSync("docs/reporting/jwt-overnight-cells.json",JSON.stringify(report,null,2)+"\n");
 console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.name,"Assessment failed");process.exitCode=1;})
 .finally(async()=>{await(await getMongoClient()).close();});
