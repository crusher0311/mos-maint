// These are normalized workflow stages, not evidence that an invoice exists.
export const COMMON_UNINVOICED_STATUSES = ["estimate","open","in_progress","work_in_progress"];
export const PROTRACTOR_UNINVOICED_STATUSES = [
  "draft","scheduled","checked_in","authorized","inspection_in_progress",
  "inspection_complete","waiting_parts","waiting_approval","work_paused","work_complete",
];
export function knownUninvoiced(provider:string,status:string) {
  return COMMON_UNINVOICED_STATUSES.includes(status) ||
    (provider==="protractor"&&PROTRACTOR_UNINVOICED_STATUSES.includes(status));
}
