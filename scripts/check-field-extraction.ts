import { MongoClient } from 'mongodb';

async function auditFieldExtraction() {
  const username = process.env.MONGODB_USERNAME;
  const password = process.env.MONGODB_PASSWORD;
  if (!username || !password) return;
  
  const uri = `mongodb+srv://${username}:${encodeURIComponent(password)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("mos-maintenance-mvp");
  
  // Sample Protractor raw payload
  const protractorWO = await db.collection('normalized_work_orders').findOne({ 
    shopId: 51,
    rawPayload: { $exists: true }
  });
  
  if (protractorWO?.rawPayload) {
    console.log("=== PROTRACTOR RAW PAYLOAD TOP-LEVEL KEYS ===");
    console.log(Object.keys(protractorWO.rawPayload).join(", "));
    
    console.log("\n=== MILEAGE FIELDS ===");
    const rp = protractorWO.rawPayload;
    console.log("MileageIn:", rp.MileageIn);
    console.log("MileageOut:", rp.MileageOut);
    console.log("Mileage:", rp.Mileage);
    console.log("Odometer:", rp.Odometer);
    
    console.log("\n=== STORED IN NORMALIZED WO ===");
    console.log("odometerIn:", protractorWO.odometerIn);
    console.log("odometerOut:", protractorWO.odometerOut);
    
    console.log("\n=== CUSTOMER FIELDS ===");
    if (rp.Customer) {
      console.log("Customer keys:", Object.keys(rp.Customer).join(", "));
      console.log("Email:", rp.Customer.Email || rp.Customer.EmailAddress);
      console.log("Phone:", rp.Customer.Phone || rp.Customer.PrimaryPhone || rp.Customer.MobilePhone);
    }
    
    console.log("\n=== STORED CUSTOMER ===");
    console.log("customer:", JSON.stringify(protractorWO.customer, null, 2));
    
    console.log("\n=== VEHICLE FIELDS ===");
    if (rp.ServiceItem) {
      console.log("ServiceItem keys:", Object.keys(rp.ServiceItem).join(", "));
    }
    
    console.log("\n=== PAYMENTS ===");
    console.log("Has Payments:", !!rp.Payments);
    if (rp.Payments?.ItemCollection) {
      console.log("Payment count:", rp.Payments.ItemCollection.length);
      if (rp.Payments.ItemCollection[0]) {
        console.log("First payment keys:", Object.keys(rp.Payments.ItemCollection[0]).join(", "));
      }
    }
    
    console.log("\n=== DEFERRED/DECLINED SERVICES ===");
    console.log("Has DeferredServices:", !!rp.DeferredServices);
    console.log("Has DeclinedServices:", !!rp.DeclinedServices);
    console.log("Has Recommendations:", !!rp.Recommendations);
  }
  
  // Check a Tekmetric payload for comparison
  const tekWO = await db.collection('normalized_work_orders').findOne({ 
    shopId: 32,
    rawPayload: { $exists: true }
  });
  
  if (tekWO?.rawPayload) {
    console.log("\n\n=== TEKMETRIC RAW PAYLOAD TOP-LEVEL KEYS ===");
    console.log(Object.keys(tekWO.rawPayload).join(", "));
    
    console.log("\n=== MILEAGE FIELDS ===");
    const rp = tekWO.rawPayload;
    console.log("mileageIn:", rp.mileageIn);
    console.log("mileageOut:", rp.mileageOut);
    
    console.log("\n=== STORED IN NORMALIZED WO ===");
    console.log("odometerIn:", tekWO.odometerIn);
    console.log("odometerOut:", tekWO.odometerOut);
  }
  
  await client.close();
}

auditFieldExtraction().catch(console.error);
