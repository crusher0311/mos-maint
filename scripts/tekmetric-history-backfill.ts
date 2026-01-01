// Tekmetric history backfill for Job Lookup feature
// Usage: npx tsx scripts/tekmetric-history-backfill.ts
// Fetches 5 years of historical repair orders and indexes jobs for Job Lookup

import { getDb } from "../lib/mongo";

const TEKMETRIC_API_BASE = "https://shop.tekmetric.com/api/v1";
const TEKMETRIC_API_TOKEN = process.env.TEKMETRIC_API_TOKEN;

type TekmetricVehicle = {
  id: number;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  subModel?: string;
  engine?: string;
  mileageIn?: number;
  mileageOut?: number;
};

type TekmetricCustomer = {
  id: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
};

type TekmetricJob = {
  id: number;
  repairOrderId: number;
  name: string;
  authorized: boolean;
  laborAmount?: number;
  partsAmount?: number;
  discountAmount?: number;
  totalAmount?: number;
  laborEntries?: Array<{
    id: number;
    description?: string;
    hours?: number;
    rate?: number;
    amount?: number;
    technicianId?: number;
  }>;
  parts?: Array<{
    id: number;
    partNumber?: string;
    description?: string;
    quantity?: number;
    cost?: number;
    retailPrice?: number;
    amount?: number;
    brand?: string;
    vendorId?: number;
  }>;
  createdDate?: string;
  updatedDate?: string;
};

type TekmetricRepairOrder = {
  id: number;
  repairOrderNumber: number;
  shopId: number;
  customerId: number;
  vehicleId: number;
  repairOrderStatus?: {
    id: number;
    code: string;
    name: string;
  };
  milesIn?: number;
  milesOut?: number;
  completedDate?: string;
  postedDate?: string;
  createdDate?: string;
  updatedDate?: string;
};

type PaginatedResponse<T> = {
  content: T[];
  totalPages: number;
  totalElements: number;
  size: number;
  number: number;
  first: boolean;
  last: boolean;
};

async function tekmetricRequest<T>(endpoint: string): Promise<T> {
  const url = `${TEKMETRIC_API_BASE}${endpoint}`;
  
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TEKMETRIC_API_TOKEN}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }

  return res.json();
}

async function getRepairOrders(
  tekmetricShopId: number,
  params: {
    page?: number;
    size?: number;
    updatedDateStart?: string;
    updatedDateEnd?: string;
    sort?: string;
    sortDirection?: "ASC" | "DESC";
  } = {}
): Promise<PaginatedResponse<TekmetricRepairOrder>> {
  const queryParams = new URLSearchParams({ shop: tekmetricShopId.toString() });
  if (params.page !== undefined) queryParams.set("page", params.page.toString());
  if (params.size !== undefined) queryParams.set("size", params.size.toString());
  if (params.updatedDateStart) queryParams.set("updatedDateStart", params.updatedDateStart);
  if (params.updatedDateEnd) queryParams.set("updatedDateEnd", params.updatedDateEnd);
  if (params.sort) queryParams.set("sort", params.sort);
  if (params.sortDirection) queryParams.set("sortDirection", params.sortDirection);
  
  return tekmetricRequest(`/repair-orders?${queryParams}`);
}

async function getJobs(
  tekmetricShopId: number,
  repairOrderId: number
): Promise<PaginatedResponse<TekmetricJob>> {
  const queryParams = new URLSearchParams({
    shop: tekmetricShopId.toString(),
    repairOrderId: repairOrderId.toString(),
    size: "100",
  });
  
  return tekmetricRequest(`/jobs?${queryParams}`);
}

async function getVehicle(vehicleId: number): Promise<TekmetricVehicle> {
  return tekmetricRequest(`/vehicles/${vehicleId}`);
}

async function getCustomer(customerId: number): Promise<TekmetricCustomer> {
  return tekmetricRequest(`/customers/${customerId}`);
}

function extractKeywords(title: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "as", "is", "was", "are", "were", "been",
    "be", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "must", "shall", "can", "need",
    "service", "package", "job", "work", "order"
  ]);
  
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
  
  return [...new Set(words)];
}

type JobIndexEntry = {
  shopId: number;
  workOrderId: string;
  workOrderNumber?: number;
  servicePackageId: string;
  performedAt: Date;
  
  vehicle: {
    vin?: string;
    year?: number;
    make?: string;
    model?: string;
    engine?: string;
  };
  
  job: {
    title: string;
    description?: string;
    code?: string;
    keywords: string[];
  };
  
  lines: Array<{
    lineType: "labor" | "part" | "sublet" | "other";
    description: string;
    partNumber?: string;
    manufacturer?: string;
    quantity: number;
    unitPrice: number;
    extendedPrice: number;
  }>;
  
  totals: {
    laborHours: number;
    laborAmount: number;
    partsAmount: number;
    totalAmount: number;
  };
  
  metadata: {
    indexedAt: Date;
    sourceType: "protractor" | "tekmetric" | "autoflow";
  };
};

async function main() {
  console.log("=== Tekmetric History Backfill ===\n");
  
  if (!TEKMETRIC_API_TOKEN) {
    console.error("Missing TEKMETRIC_API_TOKEN environment variable");
    process.exit(1);
  }
  
  const db = await getDb();
  
  // Get shops configured with Tekmetric
  const shops = await db.collection("shops").find({
    "tekmetric.shopId": { $exists: true, $ne: null }
  }).toArray();
  
  if (shops.length === 0) {
    console.log("No shops configured with Tekmetric integration");
    process.exit(0);
  }
  
  console.log(`Found ${shops.length} Tekmetric-configured shop(s)\n`);
  
  // 5 years ago - Tekmetric requires full ISO 8601 datetime with timezone
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 5);
  const startDateStr = startDate.toISOString(); // Full ISO format with timezone
  const endDateStr = new Date().toISOString();
  
  console.log(`Date range: ${startDateStr} to ${endDateStr}\n`);
  
  const historicalCollection = db.collection("sms_historical_work_orders");
  const jobIndexCollection = db.collection("job_index");
  
  for (const shop of shops) {
    const shopId = Number(shop.shopId);
    const tekmetricShopId = shop.tekmetric?.shopId;
    
    if (!tekmetricShopId) {
      console.log(`\n--- Skipping Shop ${shopId} (no Tekmetric Shop ID) ---`);
      continue;
    }
    
    console.log(`\n--- Processing Shop ${shopId} (Tekmetric Shop: ${tekmetricShopId}) ---`);
    
    let page = 0;
    let totalPages = 1;
    let totalROs = 0;
    let indexedJobs = 0;
    const seenROIds = new Set<number>();
    
    // Vehicle and customer caches to reduce API calls
    const vehicleCache = new Map<number, TekmetricVehicle>();
    const customerCache = new Map<number, TekmetricCustomer>();
    
    while (page < totalPages) {
      console.log(`\nFetching page ${page + 1}...`);
      
      try {
        const rosResponse = await getRepairOrders(tekmetricShopId, {
          page,
          size: 100,
          updatedDateStart: startDateStr,
          updatedDateEnd: endDateStr,
          sort: "updatedDate",
          sortDirection: "DESC",
        });
        
        totalPages = rosResponse.totalPages;
        const ros = rosResponse.content || [];
        
        console.log(`Page ${page + 1}/${totalPages}: ${ros.length} repair orders`);
        
        for (const ro of ros) {
          if (seenROIds.has(ro.id)) continue;
          seenROIds.add(ro.id);
          
          // Only process completed/posted repair orders
          const statusCode = ro.repairOrderStatus?.code || "";
          if (!["POSTED", "INVOICED", "COMPLETED"].includes(statusCode.toUpperCase())) {
            continue;
          }
          
          totalROs++;
          
          // Fetch vehicle (cached)
          let vehicle: TekmetricVehicle | null = null;
          if (ro.vehicleId) {
            if (vehicleCache.has(ro.vehicleId)) {
              vehicle = vehicleCache.get(ro.vehicleId)!;
            } else {
              try {
                vehicle = await getVehicle(ro.vehicleId);
                vehicleCache.set(ro.vehicleId, vehicle);
              } catch (err) {
                console.log(`  Warning: Could not fetch vehicle ${ro.vehicleId}`);
              }
            }
          }
          
          // Fetch customer (cached)
          let customer: TekmetricCustomer | null = null;
          if (ro.customerId) {
            if (customerCache.has(ro.customerId)) {
              customer = customerCache.get(ro.customerId)!;
            } else {
              try {
                customer = await getCustomer(ro.customerId);
                customerCache.set(ro.customerId, customer);
              } catch (err) {
                // Customer fetch is optional
              }
            }
          }
          
          // Fetch jobs for this RO
          let jobs: TekmetricJob[] = [];
          try {
            const jobsResponse = await getJobs(tekmetricShopId, ro.id);
            jobs = jobsResponse.content || [];
          } catch (err) {
            console.log(`  Warning: Could not fetch jobs for RO ${ro.id}`);
          }
          
          if (jobs.length === 0) continue;
          
          // Store raw historical data
          await historicalCollection.updateOne(
            { shopId, sourceSystem: "tekmetric", workOrderId: String(ro.id) },
            {
              $set: {
                shopId,
                sourceSystem: "tekmetric",
                workOrderId: String(ro.id),
                workOrderNumber: ro.repairOrderNumber,
                closedAt: ro.postedDate || ro.completedDate || ro.updatedDate,
                vehicle: vehicle ? {
                  vin: vehicle.vin,
                  year: vehicle.year,
                  make: vehicle.make,
                  model: vehicle.model,
                  engine: vehicle.engine,
                } : null,
                customer: customer ? {
                  id: customer.id,
                  name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim(),
                  email: customer.email,
                  phone: customer.phone,
                } : null,
                jobs: jobs,
                importedAt: new Date(),
              },
            },
            { upsert: true }
          );
          
          // Index each job
          for (const job of jobs) {
            const lines: JobIndexEntry["lines"] = [];
            
            // Add labor entries if available
            if (job.laborEntries && job.laborEntries.length > 0) {
              for (const labor of job.laborEntries) {
                lines.push({
                  lineType: "labor",
                  description: labor.description || job.name,
                  quantity: labor.hours || 1,
                  unitPrice: labor.rate || 0,
                  extendedPrice: labor.amount || 0,
                });
              }
            }
            
            // Add parts if available
            if (job.parts && job.parts.length > 0) {
              for (const part of job.parts) {
                lines.push({
                  lineType: "part",
                  description: part.description || "",
                  partNumber: part.partNumber,
                  manufacturer: part.brand,
                  quantity: part.quantity || 1,
                  unitPrice: part.retailPrice || part.cost || 0,
                  extendedPrice: part.amount || 0,
                });
              }
            }
            
            // Tekmetric stores amounts in cents - convert to dollars
            const laborAmountDollars = (job.laborAmount || 0) / 100;
            const partsAmountDollars = (job.partsAmount || 0) / 100;
            const totalAmountDollars = (job.totalAmount || 0) / 100;
            
            // Calculate labor hours from labor entries if available
            let laborHours = 0;
            if (job.laborEntries && job.laborEntries.length > 0) {
              laborHours = job.laborEntries.reduce((sum, l) => sum + (l.hours || 0), 0);
            } else if (laborAmountDollars > 0) {
              // Estimate labor hours based on ~$150/hr rate
              laborHours = Math.round(laborAmountDollars / 150 * 10) / 10;
            }
            
            // Convert line amounts to dollars
            const convertedLines = lines.map(line => ({
              ...line,
              unitPrice: line.unitPrice / 100,
              extendedPrice: line.extendedPrice / 100,
            }));
            
            const jobEntry: JobIndexEntry = {
              shopId,
              workOrderId: String(ro.id),
              workOrderNumber: ro.repairOrderNumber,
              servicePackageId: String(job.id),
              performedAt: new Date(ro.postedDate || ro.completedDate || ro.createdDate || Date.now()),
              
              vehicle: {
                vin: vehicle?.vin,
                year: vehicle?.year,
                make: vehicle?.make,
                model: vehicle?.model,
                engine: vehicle?.engine,
              },
              
              job: {
                title: job.name,
                keywords: extractKeywords(job.name),
              },
              
              lines: convertedLines,
              
              totals: {
                laborHours,
                laborAmount: laborAmountDollars,
                partsAmount: partsAmountDollars,
                totalAmount: totalAmountDollars,
              },
              
              metadata: {
                indexedAt: new Date(),
                sourceType: "tekmetric",
              },
            };
            
            await jobIndexCollection.updateOne(
              {
                shopId,
                workOrderId: String(ro.id),
                servicePackageId: String(job.id),
              },
              { $set: jobEntry },
              { upsert: true }
            );
            
            indexedJobs++;
          }
          
          // Rate limiting
          await new Promise(r => setTimeout(r, 50));
        }
        
        page++;
        
      } catch (err: any) {
        console.error(`Error fetching page ${page}:`, err.message);
        break;
      }
    }
    
    console.log(`\n=== Shop ${shopId} Summary ===`);
    console.log(`  Total closed ROs processed: ${totalROs}`);
    console.log(`  Jobs indexed: ${indexedJobs}`);
  }
  
  console.log("\n=== Backfill Complete ===");
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
