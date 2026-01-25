export type ProtractorConfig = {
  connectionId: string;
  apiKey: string;
  authentication: string;
  configured: boolean;
};

export type ProtractorContact = {
  ID: string;
  FileAs?: string;
  Name?: {
    FirstName?: string;
    LastName?: string;
    Title?: string;
  };
  Address?: {
    Street?: string;
    City?: string;
    Province?: string;
    PostalCode?: string;
  };
  Phone1?: string;
  Phone2?: string;
  Email?: string;
  Company?: string;
};

export type ProtractorVehicle = {
  ID: string;
  OwnerID?: string;
  LookUp?: string;
  Lookup?: string;
  VIN?: string;
  Year?: number;
  Make?: string;
  Model?: string;
  Submodel?: string;
  Color?: string;
  Engine?: string;
  Transmission?: string;
  Odometer?: number;
  OdometerDate?: string;
  Usage?: number;
  LicensePlate?: string;
  PlateRegistration?: string;
  Owner?: ProtractorContact;
};

export type ProtractorWorkOrder = {
  ID: string;
  WorkOrderNumber?: number;
  Type?: string;
  Status?: string;
  WorkflowStage?: string;
  ServiceItemID?: string;
  ServiceItem?: ProtractorVehicle;
  ContactID?: string;
  Contact?: ProtractorContact;
  ServiceAdvisorID?: string;
  TechnicianID?: string;
  ScheduledTime?: string;
  PromisedTime?: string;
  Odometer?: number;
  InUsage?: number;
  OutUsage?: number;
  Duration?: number;
  Completed?: boolean;
  ServicePackages?: ProtractorServicePackage[];
  Header?: {
    CreationTime?: string;
    LastModifiedTime?: string;
  };
};

export type ProtractorServicePackage = {
  ID: string;
  Title?: string;
  Description?: string;
  Chapter?: string;
  Status?: string;
  ServicePackageLines?: ProtractorServicePackageLine[];
  InspectionLines?: ProtractorInspectionLine[];
};

export type ProtractorServicePackageLine = {
  ID: string;
  LineType?: string;
  Description?: string;
  Quantity?: number;
  UnitPrice?: number;
  ExtendedPrice?: number;
  Status?: string;
  PartNumber?: string;
  Manufacturer?: string;
};

export type ProtractorInspectionLine = {
  ID: string;
  Description?: string;
  Result?: string;
  Notes?: string;
  Pictures?: string[];
};

export type ProtractorInvoice = {
  ID: string;
  InvoiceNumber?: number;
  InvoiceDate?: string;
  ServiceItemID?: string;
  ServiceItem?: ProtractorVehicle;
  ContactID?: string;
  Contact?: ProtractorContact;
  Odometer?: number;
  Total?: number;
  ServicePackages?: ProtractorServicePackage[];
};

export type ProtractorDeferredWork = {
  ID: string;
  ServiceItemID?: string;
  Title?: string;
  Description?: string;
  Reason?: string;
  CreatedDate?: string;
  OriginalWorkOrderID?: string;
  EstimatedCost?: number;
  Chapter?: string;
  Code?: string;
  Status?: string;
  Rank?: number;
  ServicePackageHeader?: {
    Title?: string;
    Description?: string;
  };
  Header?: {
    CreationTime?: string;
    LastModifiedTime?: string;
  };
};

export type ProtractorActiveInspection = {
  ID: string;
  WorkOrderID?: string;
  Title?: string;
  Description?: string;
  Status?: string;
  InspectionDate?: string;
  TechnicianID?: string;
  TechnicianName?: string;
  Items?: ProtractorInspectionItem[];
};

export type ProtractorInspectionItem = {
  ID: string;
  Name?: string;
  Description?: string;
  Category?: string;
  Result?: string;
  Notes?: string;
  Severity?: string;
  Pictures?: Array<{ URL?: string; Description?: string }>;
};

export type ProtractorCannedJob = {
  ID: string;
  Title?: string;
  Description?: string;
  Chapter?: string;
  Code?: string;
  Status?: string;
  ServicePackageLines?: ProtractorServicePackageLine[];
  Header?: {
    CreationTime?: string;
    LastModifiedTime?: string;
  };
};

export type ProtractorServicePackageTemplate = {
  ID: string;
  Title?: string;
  Description?: string;
  Chapter?: string;
  Code?: string;
  Status?: string;
  Header?: {
    CreationTime?: string;
    LastModifiedTime?: string;
  };
};

export interface CreateProtractorAppointmentParams {
  contactId: string;
  serviceItemId: string;
  scheduledTime: string;
  duration?: number;
  description?: string;
  serviceAdvisorId?: string;
}

export interface ProtractorAppointmentResult {
  ok: boolean;
  appointmentId?: string;
  workOrderId?: string;
  error?: string;
}
