import { MongoClient } from 'mongodb';
const uri = `mongodb+srv://${process.env.MONGODB_USERNAME}:${encodeURIComponent(process.env.MONGODB_PASSWORD!)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true`;
const c = new MongoClient(uri);
await c.connect();
const ops: any = await c.db('admin').command({ currentOp: 1, active: true, secs_running: { $gte: 2 } });
for (const op of ops.inprog.slice(0, 20)) {
  console.log(op.secs_running + 's', op.op, op.ns, JSON.stringify(op.command || {}).slice(0, 200));
}
console.log('total active >=2s:', ops.inprog.length);
await c.close();
