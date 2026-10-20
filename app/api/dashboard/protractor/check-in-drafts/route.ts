import { getSession } from "@/lib/auth";
import { checkInAccess } from "@/lib/auto-dvi/staff/check-in-access";
import { CheckInDrafts } from "@/lib/data/repositories/check-in-drafts";
import { dispatchFailure,dispatchJson,requestBody } from "@/lib/shop-dispatch/http";
import { requireThat } from "@/lib/shop-dispatch/model";
import { z,ZodError } from "zod";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const drafts=new CheckInDrafts();
async function access(){requireThat(await getSession(),"Sign in required",401);return checkInAccess();}
export async function GET(req:Request){
  try{
    const s=await access(),p=new URL(req.url).searchParams,id=p.has("id")?z.string().uuid().parse(p.get("id")):undefined;
    if(p.has("photo")){
      requireThat(id,"Draft identity required",400);
      const file=await drafts.photo(s,id,z.string().uuid().parse(p.get("photo")));
      return new Response(new Uint8Array(file.bytes),{headers:{"Content-Type":file.mime,"Content-Length":String(file.bytes.length),"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'"}});
    }
    return dispatchJson({draft:drafts.public(await drafts.read(s,id))});
  }catch(e){return e instanceof ZodError?dispatchJson({error:"Invalid draft identity"},400):dispatchFailure(e);}
}
export async function POST(req:Request){
  try{const s=await access(),body=await requestBody(req,5700000);return dispatchJson({draft:drafts.public(await drafts.write(s,body))});}
  catch(e){return e instanceof ZodError||e instanceof SyntaxError?dispatchJson({error:"Invalid draft request"},400):dispatchFailure(e);}
}
