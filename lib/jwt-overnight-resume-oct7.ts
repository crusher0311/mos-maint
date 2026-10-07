import {createHash} from "node:crypto";
import {resumeWindows} from "./jwt-overnight-resume";
export const OCT7_PARENT = "jwt-overnight-2026-10-06";
export const OCT7_PARENT_RUN = "aca31d51-77cb-4eaa-9f43-2fc5f4c7e72b";
export const OCT7_CONSUMED = 65;
export function oct7Resume(parent:any, grandparent:any, original:string[], hash:string) {
 const prior=resumeWindows(grandparent,original,hash);
 if(parent?.status!=="paused"||parent.stopped||parent.manifestHash!==hash||
    parent.parentJobId!=="jwt-overnight-2026-10-05"||parent.runId!==OCT7_PARENT_RUN||
    parent.cursor!==41||parent.page!==0||
    parent.outcomes?.corrected!==387||parent.outcomes?.held!==581||parent.outcomes?.["already-matches"]!==150||
    createHash("sha256").update(JSON.stringify(parent.results??[])).digest("hex")!==
      "30a6d85ae8f34703a169b6349d68b400ea614ea0e62c0db46313820f46b62a2e")
   throw Error("October 6 parent changed; reconciliation required");
 const windows=prior.slice(parent.cursor);
 if(windows[0]!=="230:2026-09-18")throw Error("Unexpected resume window");
 return {windows,recorded:new Set<string>(parent.results.map((r:any)=>`${r.shopId}:${r.day}:${r.wo}`))};
}
