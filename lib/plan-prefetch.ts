interface PrefetchItem {
  vin: string;
  mileage: number;
  shopId: number;
  priority: "high" | "normal";
}

interface VehicleForPrefetch {
  vin: string;
  mileage?: number | null;
  inProgress?: boolean;
  shopId?: number;
}

const PREFETCH_QUEUE: PrefetchItem[] = [];
const PREFETCHED_VINS = new Set<string>();
const PREFETCH_TTL = 4 * 60 * 60 * 1000; // 4 hours - matches plan cache TTL
const REFRESH_BUFFER = 15 * 60 * 1000; // 15 minutes before expiry, schedule refresh
const MAX_CONCURRENT = 2;
const PREFETCH_DELAY = 300;

let activeRequests = 0;
let processingScheduled = false;
let refreshCheckInterval: ReturnType<typeof setInterval> | null = null;

const prefetchTimestamps: Map<string, number> = new Map();
const prefetchMileages: Map<string, number> = new Map();
const prefetchShopIds: Map<string, number> = new Map();

function isPrefetchValid(vin: string): boolean {
  const timestamp = prefetchTimestamps.get(vin);
  if (!timestamp) return false;
  return Date.now() - timestamp < PREFETCH_TTL;
}

function isPrefetchExpiringSoon(vin: string): boolean {
  const timestamp = prefetchTimestamps.get(vin);
  if (!timestamp) return false;
  const timeRemaining = PREFETCH_TTL - (Date.now() - timestamp);
  return timeRemaining > 0 && timeRemaining < REFRESH_BUFFER;
}

function scheduleNextProcess() {
  if (processingScheduled) return;
  if (PREFETCH_QUEUE.length === 0) return;
  if (activeRequests >= MAX_CONCURRENT) return;
  
  processingScheduled = true;
  setTimeout(() => {
    processingScheduled = false;
    processNextItem();
  }, PREFETCH_DELAY);
}

function processNextItem() {
  if (activeRequests >= MAX_CONCURRENT) {
    return;
  }
  
  if (PREFETCH_QUEUE.length === 0) {
    return;
  }

  const item = PREFETCH_QUEUE.shift();
  if (!item) {
    scheduleNextProcess();
    return;
  }

  const { vin, mileage, shopId } = item;

  if (isPrefetchValid(vin)) {
    scheduleNextProcess();
    return;
  }

  activeRequests++;

  fetch(`/api/plan-build?vin=${encodeURIComponent(vin)}&mileage=${mileage}`, {
    method: "POST",
    credentials: "include",
  })
    .then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        prefetchTimestamps.set(vin, Date.now());
        prefetchMileages.set(vin, mileage);
        prefetchShopIds.set(vin, shopId);
        PREFETCHED_VINS.add(vin);
        if (data.built) {
          console.log(`[Prefetch] Shop ${shopId}: Built plan for ${vin} at ${mileage} mi in ${data.duration}ms`);
        } else if (data.cached) {
          console.log(`[Prefetch] Shop ${shopId}: Already cached ${vin}`);
        } else if (data.skipped) {
          console.log(`[Prefetch] Shop ${shopId}: Skipped ${vin}: ${data.reason}`);
        }
      }
    })
    .catch((err) => {
      console.log(`[Prefetch] Shop ${shopId}: Failed ${vin}:`, err.message);
    })
    .finally(() => {
      activeRequests--;
      scheduleNextProcess();
    });

  if (activeRequests < MAX_CONCURRENT && PREFETCH_QUEUE.length > 0) {
    scheduleNextProcess();
  }
}

function checkAndRefreshExpiring() {
  const vinsToRefresh: string[] = [];
  
  prefetchTimestamps.forEach((timestamp, vin) => {
    if (isPrefetchExpiringSoon(vin)) {
      const mileage = prefetchMileages.get(vin);
      if (mileage) {
        vinsToRefresh.push(vin);
      }
    }
  });

  vinsToRefresh.forEach((vin) => {
    const mileage = prefetchMileages.get(vin);
    const shopId = prefetchShopIds.get(vin);
    if (mileage && shopId) {
      prefetchTimestamps.delete(vin);
      queuePrefetch(vin, mileage, shopId, "normal");
    }
  });
}

function startRefreshChecker() {
  if (refreshCheckInterval) return;
  
  refreshCheckInterval = setInterval(() => {
    checkAndRefreshExpiring();
  }, 5 * 60 * 1000); // Check every 5 minutes
}

function stopRefreshChecker() {
  if (refreshCheckInterval) {
    clearInterval(refreshCheckInterval);
    refreshCheckInterval = null;
  }
}

export function queuePrefetch(
  vin: string, 
  mileage: number | null | undefined,
  shopId: number,
  priority: "high" | "normal" = "normal"
) {
  if (!vin || vin.length !== 17) return;
  if (!shopId) return;
  
  if (!mileage || mileage <= 0) {
    return;
  }
  
  const upperVin = vin.toUpperCase();
  
  if (isPrefetchValid(upperVin)) {
    return;
  }
  
  const existingIndex = PREFETCH_QUEUE.findIndex(item => item.vin === upperVin);
  if (existingIndex !== -1) {
    if (priority === "high" && PREFETCH_QUEUE[existingIndex].priority !== "high") {
      PREFETCH_QUEUE.splice(existingIndex, 1);
    } else {
      return;
    }
  }

  const item: PrefetchItem = { vin: upperVin, mileage, shopId, priority };
  
  if (priority === "high") {
    PREFETCH_QUEUE.unshift(item);
  } else {
    PREFETCH_QUEUE.push(item);
  }

  startRefreshChecker();
  scheduleNextProcess();
}

export function queueMultiplePrefetch(
  vehicles: VehicleForPrefetch[],
  shopId: number,
  maxCount: number = 10
) {
  if (!shopId) return;
  
  const withMileage = vehicles.filter(v => v.mileage && v.mileage > 0);
  
  if (withMileage.length === 0) {
    return;
  }

  const sorted = [...withMileage].sort((a, b) => {
    if (a.inProgress && !b.inProgress) return -1;
    if (!a.inProgress && b.inProgress) return 1;
    return 0;
  });

  const toQueue = sorted.slice(0, maxCount);
  
  console.log(`[Prefetch] Shop ${shopId}: Queuing ${toQueue.length} vehicles (from ${vehicles.length} total)`);
  
  toQueue.forEach((v, index) => {
    const priority = v.inProgress ? "high" : "normal";
    setTimeout(() => {
      queuePrefetch(v.vin, v.mileage, shopId, priority);
    }, index * 200);
  });
}

export function triggerPrefetchOnMileageUpdate(vin: string, mileage: number, shopId: number) {
  if (!vin || vin.length !== 17 || !mileage || mileage <= 0 || !shopId) return;
  
  const upperVin = vin.toUpperCase();
  const previousMileage = prefetchMileages.get(upperVin);
  
  if (previousMileage && previousMileage === mileage && isPrefetchValid(upperVin)) {
    return;
  }
  
  prefetchTimestamps.delete(upperVin);
  queuePrefetch(upperVin, mileage, shopId, "high");
}

export function isPrefetched(vin: string): boolean {
  return isPrefetchValid(vin.toUpperCase());
}

export function getPrefetchStats() {
  return {
    queueLength: PREFETCH_QUEUE.length,
    prefetchedCount: PREFETCHED_VINS.size,
    activeRequests,
    ttlMinutes: Math.round(PREFETCH_TTL / 60000),
    refreshBufferMinutes: Math.round(REFRESH_BUFFER / 60000),
  };
}

export function clearPrefetchCache() {
  prefetchTimestamps.clear();
  prefetchMileages.clear();
  prefetchShopIds.clear();
  PREFETCHED_VINS.clear();
  PREFETCH_QUEUE.length = 0;
  stopRefreshChecker();
}
