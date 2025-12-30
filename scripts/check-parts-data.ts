import { getDb } from "../lib/mongo";

async function checkPartsData() {
  const db = await getDb();
  
  const shopId = 25;
  
  console.log("=== Checking Parts Data ===\n");
  
  const partsCount = await db.collection("part_cross_ref").countDocuments({ shopId });
  console.log(`part_cross_ref count for shop ${shopId}: ${partsCount}`);
  
  const jobIndexCount = await db.collection("job_index").countDocuments({ shopId });
  console.log(`job_index count for shop ${shopId}: ${jobIndexCount}`);
  
  const workOrdersCount = await db.collection("protractor_work_orders").countDocuments({ shopId });
  console.log(`protractor_work_orders count for shop ${shopId}: ${workOrdersCount}`);
  
  console.log("\n=== Sample Work Order Structure ===\n");
  const sampleWO = await db.collection("protractor_work_orders").findOne({ shopId });
  if (sampleWO) {
    console.log("Keys:", Object.keys(sampleWO));
    console.log("servicePackages type:", typeof sampleWO.servicePackages);
    console.log("servicePackages is array:", Array.isArray(sampleWO.servicePackages));
    
    if (sampleWO.servicePackages?.ItemCollection) {
      console.log("Has ItemCollection:", sampleWO.servicePackages.ItemCollection.length);
    } else if (Array.isArray(sampleWO.servicePackages)) {
      console.log("servicePackages length:", sampleWO.servicePackages.length);
      if (sampleWO.servicePackages[0]) {
        const pkg = sampleWO.servicePackages[0];
        console.log("\nFirst package keys:", Object.keys(pkg));
        console.log("ServicePackageLines:", pkg.ServicePackageLines ? "exists" : "missing");
        if (pkg.ServicePackageLines?.ItemCollection) {
          console.log("Lines count:", pkg.ServicePackageLines.ItemCollection.length);
          const partLines = pkg.ServicePackageLines.ItemCollection.filter((l: any) => 
            (l.Type || l.LineType || "").toLowerCase().includes("part")
          );
          console.log("Part lines count:", partLines.length);
          if (partLines[0]) {
            console.log("Sample part line:", JSON.stringify(partLines[0], null, 2));
          }
        } else if (Array.isArray(pkg.ServicePackageLines)) {
          console.log("Lines count:", pkg.ServicePackageLines.length);
        } else {
          console.log("No lines found in package");
        }
      }
    }
  } else {
    console.log("No work orders found");
  }
  
  console.log("\n=== Sample Job Index Entry ===\n");
  const sampleJob = await db.collection("job_index").findOne({ shopId });
  if (sampleJob) {
    console.log("Job title:", sampleJob.job?.title);
    console.log("Lines count:", sampleJob.lines?.length);
    const partLines = sampleJob.lines?.filter((l: any) => l.lineType === "part") || [];
    console.log("Part lines:", partLines.length);
    if (partLines[0]) {
      console.log("Sample part:", JSON.stringify(partLines[0], null, 2));
    }
  }
  
  console.log("\n=== Sample Parts ===\n");
  const sampleParts = await db.collection("part_cross_ref").find({ shopId }).limit(5).toArray();
  console.log("Found parts:", sampleParts.length);
  sampleParts.forEach((p, i) => {
    console.log(`Part ${i + 1}: ${p.partNumber} - ${p.description}`);
  });
  
  process.exit(0);
}

checkPartsData().catch(console.error);
