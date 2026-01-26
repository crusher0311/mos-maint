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
