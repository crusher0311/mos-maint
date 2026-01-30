# Protractor Integration Reference

## Overview
This document covers key implementation details for the Protractor SMS (Shop Management System) integration.

## Adding Jobs to Work Orders

### From Job History (`/api/jobs/add-to-ro`)

When adding a job from history to an active work order, the system handles labor and parts pricing differently:

#### Labor Rate Calculation (3-Tier Fallback)

Labor lines use a smart rate lookup to ensure the shop's current rate is applied, even when adding from a different location's history:

1. **Work Order Lines**: First checks existing labor lines on the current work order
2. **Shop Job History**: Queries the `job_index` collection for the shop's most recent job with labor to find their typical rate
3. **Historical Fallback**: Uses the historical rate from the job being added (only if no shop rate is found)

```typescript
// Priority order for labor rate lookup:
// 1. Existing WO lines -> shop's current rate on this job
// 2. job_index lookup -> shop's typical rate from recent jobs
// 3. Historical rate -> rate from the job being added
```

#### Parts Pricing

Parts/materials use the historical pricing from the job being added, including:
- Unit price
- Quantity
- Extended total
- Part numbers and manufacturers

### Line Format for Protractor API

**Labor Lines:**
```typescript
{
  Type: "Labor",
  Description: "Labor",
  Quantity: "1.5",
  RateCode: "1",
  TechnicianHour: "1.5",
  Price: "155.00",      // Shop's current labor rate
  Total: "232.50",      // Calculated: quantity × rate
  ExtendedTotal: "232.50",
  MinimumCharge: 0,
  Discount: 0,
  Completed: false,
}
```

**Parts Lines:**
```typescript
{
  Type: "Material",
  Description: "Brake Pads - Rear",
  Quantity: "1",
  Unit: "Each",
  Price: "76.17",       // Historical unit price
  Total: "76.17",
  ExtendedTotal: "76.17",
  Cost: "45.70",        // Estimated cost (60% of price)
  TotalCost: "45.70",
  PartNumber: "DG967",
  Manufacturer: "Duralast Gold",
  Completed: false,
}
```

### From Deferred Work (`/api/jobs/add-deferred`)

Deferred work uses cached pricing from the `job_index` or original work order, preserving the exact pricing from when the work was originally quoted.

## Service Title Normalization

The job history search normalizes service titles for better matching:

| OEM/Recommendation Title | Normalized Search Term |
|-------------------------|----------------------|
| "Replace spark plugs." | "spark plug" |
| "Engine Air Filter" | "air filter" |
| "Cabin Air Filter" | "cabin filter" |
| "Brake pads inspection" | "brake pads" |

Using singular forms improves matching with job history entries that may use various naming conventions.

## Key Fields Reference

### RateCode
- `"1"` = Default labor rate (most common)
- Protractor uses this to look up the shop's configured labor rate
- When `Price` is also sent, Protractor uses the explicit Price value

### TechnicianHour
- Labor hours for the line (e.g., `"1.5"` for 1.5 hours)
- Used in conjunction with RateCode for labor calculations

### Chapter
- `"Service"` = Active work on the repair order
- `"Deferred"` = Deferred/declined work section

### Status
- `"Pending"` = Work not started
- `"InProgress"` = Work underway
- `"Completed"` = Work finished

## Appointment Creation

When creating appointments via the API, we POST to `/WorkOrder/{id}` with:

```typescript
{
  ID: newWorkOrderId,           // Generated UUID
  WorkOrderNumber: 0,           // Required for new work orders
  Type: "Appointment",          // Sets it as an appointment
  Contact: { ID: contactId },   // Customer reference
  ServiceItem: { ID: vehicleId }, // Vehicle reference
  ScheduledTime: scheduledTime, // ISO date string with timezone
  Duration: duration / 60,      // Duration in hours (we pass minutes, convert)
  Note: notes,                  // Appointment details
  ServiceAdvisor: { ID: serviceAdvisorId } // Optional
}
```

**Note:** We do NOT explicitly set `WorkflowStage` or `Status` - Protractor determines the default stage for new appointments.

## Callback/Webhook Behavior

**Important Limitation (confirmed Jan 2026):**

Protractor's callback/webhook system does **NOT** include events for initial API inputs. This means:

- When we create an appointment via POST, we will **NOT** receive a webhook callback for the creation
- Webhooks only fire for **subsequent updates/changes** to records
- We rely on the **direct API response** (e.g., `WorkOrderNumber: 46386`) to confirm successful creation

This applies to all record types created via API, not just appointments. Third-party integrations that rely on Protractor callbacks will also not receive initial creation events - only updates.

**Current Impact:** None - our flow uses the direct API response for confirmation.

**Future Consideration:** If we ever need to track creation events for external systems, we would need to implement our own event emission after successful API calls.
