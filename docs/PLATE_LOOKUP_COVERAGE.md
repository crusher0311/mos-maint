# Plate Lookup Coverage

The "Lookup VIN" button in the New Work Order modal (Protractor flow) calls
`POST /api/vin/plate-lookup`, which forwards the plate + 2-letter region code
to our vendor, **PlateToVIN** (`https://platetovin.com/api/convert`).

## Vendor coverage

PlateToVIN supports **US states only**. This is documented by the vendor:

- API docs (`https://platetovin.com/doc`) title their endpoint
  "**US License Plate to VIN**" and describe themselves as "a supplier of
  US license plate to VIN data."
- The home page tagline is "Convert **US** License Plates to VIN Numbers
  via API."

### Supported regions

All 50 US states plus DC:

```
AL, AK, AZ, AR, CA, CO, CT, DE, FL, GA, HI, ID, IL, IN, IA, KS, KY, LA,
ME, MD, MA, MI, MN, MS, MO, MT, NE, NV, NH, NJ, NM, NY, NC, ND, OH, OK,
OR, PA, RI, SC, SD, TN, TX, UT, VT, VA, WA, WV, WI, WY, DC
```

### Unsupported regions

All 13 Canadian provinces and territories:

```
AB, BC, MB, NB, NL, NS, NT, NU, ON, PE, QC, SK, YT
```

## Behavior in the app

The plate-state selector still lists Canadian provinces (so a shop with
mixed US/Canadian customers can record the province on the vehicle), but
the optgroup label reads **"Canadian Provinces (plate lookup not
supported)"** to hint at the limitation.

When a user picks a Canadian province and clicks **Lookup VIN**:

- The client short-circuits and shows:
  > Plate lookup isn't available for {Province} yet — our plate-to-VIN
  > provider only covers US states. Please enter the VIN manually.
- The backend (`app/api/vin/plate-lookup/route.ts`) also enforces the
  same check as defense-in-depth, returning
  `{ success: false, unsupportedRegion: true, region, error }` without
  forwarding to PlateToVIN. This avoids burning a paid API call ($0.05
  each) on a request we know will fail.

## Support guidance

- If a shop reports "no VIN found" for a Canadian plate, confirm they
  selected a Canadian province in the dropdown — they should now see the
  region-specific message above. Ask them to enter the VIN manually for
  Canadian vehicles.
- If a shop asks when Canadian coverage is coming, the answer is "not on
  the PlateToVIN roadmap as of vendor docs last updated June 2023." A
  separate vendor (e.g. CARFAX Canada, VinAudit, or a provincial registry
  integration) would be required.

## Where to update if vendor coverage changes

`UNSUPPORTED_PLATE_REGIONS` is defined in two places and must be kept in
sync:

- `app/api/vin/plate-lookup/route.ts` (server-side guard)
- `components/NewWorkOrderModal.tsx` (client-side guard)

Removing a region code from both maps re-enables forwarding to the vendor
for that region.
