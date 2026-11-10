/** File-only CLI. Deliberately has no apply, capture, fetch or delivery mode. */
import {readFileSync,writeFileSync,statSync} from "node:fs";
import {buildRecoveryReview,validateReferences,TELLE_REFERENCE_HASH} from "./lib/telle-recovery-review";
const load=(path:string)=>{
  if(statSync(path).size>128*1024*1024)throw Error("input_file_too_large");
  return JSON.parse(readFileSync(path,"utf8"));
};
try{
  const [mode,...args]=process.argv.slice(2);
  if(mode==="--verify-scope"&&args.length===1){
    const rows=validateReferences(load(args[0]));
    console.log(JSON.stringify({verified:true,references:rows.length,referenceHash:TELLE_REFERENCE_HASH,providerRequests:0}));
  }else if(mode==="--review"&&args.length===4){
    const [refs,captures,inventory,output]=args;
    const result=buildRecoveryReview(load(refs),load(captures),load(inventory));
    writeFileSync(output,JSON.stringify(result,null,2),{mode:0o600,flag:"wx"});
    console.log(JSON.stringify({mode:result.mode,counts:result.counts,writeAuthorized:false,deliveryAuthorized:false}));
  }else throw Error("usage_verify_scope_or_review");
}catch(e){
  console.error(JSON.stringify({failed:true,reason:e instanceof Error&&/^[a-z_]+$/.test(e.message)?e.message:"invalid_input"}));
  process.exitCode=1;
}
