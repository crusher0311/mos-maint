const PREFETCH_QUEUE: string[] = [];
const PREFETCHED_VINS = new Set<string>();
const PREFETCH_TTL = 10 * 60 * 1000;
const MAX_CONCURRENT = 2;
const PREFETCH_DELAY = 300;

let activeRequests = 0;
let processingScheduled = false;

const prefetchTimestamps: Map<string, number> = new Map();

function isPrefetchValid(vin: string): boolean {
  const timestamp = prefetchTimestamps.get(vin);
  if (!timestamp) return false;
  return Date.now() - timestamp < PREFETCH_TTL;
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

  const vin = PREFETCH_QUEUE.shift();
  if (!vin) {
    scheduleNextProcess();
    return;
  }

  if (isPrefetchValid(vin)) {
    scheduleNextProcess();
    return;
  }

  activeRequests++;
  
  fetch(`/api/plan-prefetch?vin=${encodeURIComponent(vin)}`, {
    method: "POST",
    credentials: "include",
  })
    .then((res) => {
      if (res.ok) {
        prefetchTimestamps.set(vin, Date.now());
        PREFETCHED_VINS.add(vin);
        console.log(`[Prefetch] Cached plan data for ${vin}`);
      }
    })
    .catch((err) => {
      console.log(`[Prefetch] Failed for ${vin}:`, err.message);
    })
    .finally(() => {
      activeRequests--;
      scheduleNextProcess();
    });

  if (activeRequests < MAX_CONCURRENT && PREFETCH_QUEUE.length > 0) {
    scheduleNextProcess();
  }
}

export function queuePrefetch(vin: string, priority: "high" | "normal" = "normal") {
  if (!vin || vin.length !== 17) return;
  
  const upperVin = vin.toUpperCase();
  
  if (isPrefetchValid(upperVin)) {
    return;
  }
  
  if (PREFETCH_QUEUE.includes(upperVin)) {
    return;
  }

  if (priority === "high") {
    PREFETCH_QUEUE.unshift(upperVin);
  } else {
    PREFETCH_QUEUE.push(upperVin);
  }

  scheduleNextProcess();
}

export function queueMultiplePrefetch(
  vehicles: Array<{ vin: string; inProgress?: boolean }>,
  maxCount: number = 10
) {
  const sorted = [...vehicles].sort((a, b) => {
    if (a.inProgress && !b.inProgress) return -1;
    if (!a.inProgress && b.inProgress) return 1;
    return 0;
  });

  const toQueue = sorted.slice(0, maxCount);
  
  toQueue.forEach((v, index) => {
    const priority = v.inProgress ? "high" : "normal";
    setTimeout(() => {
      queuePrefetch(v.vin, priority);
    }, index * 200);
  });
}

export function isPrefetched(vin: string): boolean {
  return isPrefetchValid(vin.toUpperCase());
}

export function getPrefetchStats() {
  return {
    queueLength: PREFETCH_QUEUE.length,
    prefetchedCount: PREFETCHED_VINS.size,
    activeRequests,
  };
}
