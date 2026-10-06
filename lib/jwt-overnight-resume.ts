export const JWT_RESUME_PARENT="jwt-overnight-2026-10-05";
export function resumeWindows(parent:any, original:string[], manifestHash:string):string[] {
 if(parent?.status!=="paused" || parent.manifestHash!==manifestHash || parent.cursor!==24 || parent.page!==0 ||
    parent.runId!=="fa7377a4-5f91-4d75-b1a6-14eb24920b3e" ||
    parent.outcomes?.corrected!==231 || parent.outcomes?.held!==267 || parent.outcomes?.["already-matches"]!==84)
   throw Error("Resume parent changed; re-reconcile before starting");
 const deferred=(parent.holds??[]).map((h:any)=>`${h.shopId}:${h.day}`);
 if(deferred.some((key:string)=>!original.includes(key)))throw Error("Unexpected deferred scope");
 return [...new Set([...original.slice(parent.cursor),...deferred])];
}
