// Re-export shim — types live alongside the canonical client.
// Kept so the per-provider module shape matches the documented contract.
export type {
  ProtractorConfig,
  ProtractorVehicle,
  ProtractorWorkOrder,
  ProtractorCannedJob,
  ProtractorContact,
  ProtractorDeferredWork,
  ProtractorActiveInspection,
  ProtractorInspectionItem,
  ProtractorInspectionLine,
  ProtractorInvoice,
  ProtractorServicePackage,
  ProtractorServicePackageLine,
  ProtractorServicePackageTemplate,
  CreateProtractorAppointmentParams,
  ProtractorAppointmentResult,
} from './client';
