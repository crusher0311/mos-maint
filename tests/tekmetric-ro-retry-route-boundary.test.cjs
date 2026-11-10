const assert=require('node:assert/strict');
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const baseline=process.argv[2];
assert.match(baseline,/^[a-f0-9]{40}$/);
const route='app/api/cron/tekmetric-ro-retry/route.ts';
const admin='app/api/platform-admin/shops/[shopId]/ro-retry/route.ts';
const original=execFileSync('git',['show',`${baseline}:${route}`],{encoding:'utf8'});
const current=fs.readFileSync(route,'utf8');
const helper=fs.readFileSync('lib/integrations/tekmetric/ro-retry-service.ts','utf8');
const marker='// Task: cron/backfill Tekmetric traffic';
assert.equal(helper.slice(helper.indexOf('const MAX_SHOPS_PER_RUN')),original.slice(original.indexOf('const MAX_SHOPS_PER_RUN'),original.indexOf(marker)));
assert.equal(current.slice(current.indexOf(marker)),original.slice(original.indexOf(marker)));
assert.equal(fs.readFileSync(admin,'utf8'),execFileSync('git',['show',`${baseline}:${admin}`],{encoding:'utf8'}).replace('@/app/api/cron/tekmetric-ro-retry/route','@/lib/integrations/tekmetric/ro-retry-service'));
const routeExports=[...current.matchAll(/^export (?:async function|const) (\w+)/gm)].map(m=>m[1]);
assert.deepEqual(routeExports,['runtime','dynamic','maxDuration','GET','POST']);
for(const setting of ['runtime','dynamic','maxDuration']){
 const expression=new RegExp(`export const ${setting} = ([^;]+);`);
 assert.equal(current.match(expression)[1],original.match(expression)[1]);
}
assert.match(current,/const CRON_SECRET = process.env.CRON_SECRET;/);
console.log('PASS route exports allowed; HTTP authorization, priority, configuration, retry budgets and admin service behavior preserved verbatim');
