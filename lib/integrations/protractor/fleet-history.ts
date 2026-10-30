// Stable service entrypoint. Persistence and compare-and-set operations belong
// to the fleet history repository, including canonical progress-store routing.
export {
  __fleetHistoryDeps, fleetHistorySnapshot, fleetHistoryStatus,
  saveFleetHistoryConfig, controlFleetHistory, runFleetHistoryTick,
} from "@/lib/data/repositories/protractor-fleet-history";
