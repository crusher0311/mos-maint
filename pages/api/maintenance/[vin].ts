// Keep both router entrypoints at the project root. Next 15's route type
// generator shares the pages router's root with app-router validators.
// Retain the legacy implementation and public URL without duplicating it.
export { default } from "../../../src/pages/api/maintenance/[vin]";
