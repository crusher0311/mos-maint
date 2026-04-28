/**
 * OE (Original Equipment) make-logo lookup for the Vehicle Health Report.
 *
 * Real-world shop / DMS data uses a wide variety of spellings, abbreviations
 * and aliases for the same vehicle make (e.g. `MERCEDES`, `MERCEDES BENZ`,
 * `MERCEDES-BENZ AG` all mean Mercedes-Benz). The canonical map keys here
 * match the asset filenames under `public/logos/makes/`. The alias map
 * normalizes common variants onto those canonical keys so the lookup
 * resolves a logo instead of rendering nothing.
 */

export const OE_LOGO_MAP: Record<string, string> = {
  ACURA: "/logos/makes/acura.png",
  "ALFA ROMEO": "/logos/makes/alfa-romeo.png",
  AUDI: "/logos/makes/audi.png",
  BENTLEY: "/logos/makes/bentley.png",
  BMW: "/logos/makes/bmw.png",
  BUICK: "/logos/makes/buick.png",
  CADILLAC: "/logos/makes/cadillac.png",
  CHEVROLET: "/logos/makes/chevrolet.png",
  CHRYSLER: "/logos/makes/chrysler.png",
  DODGE: "/logos/makes/dodge.png",
  FERRARI: "/logos/makes/ferrari.png",
  FIAT: "/logos/makes/fiat.png",
  FORD: "/logos/makes/ford.png",
  GENESIS: "/logos/makes/genesis.png",
  GMC: "/logos/makes/gmc.png",
  HONDA: "/logos/makes/honda.png",
  HUMMER: "/logos/makes/hummer.png",
  HYUNDAI: "/logos/makes/hyundai.png",
  INFINITI: "/logos/makes/infiniti.png",
  JAGUAR: "/logos/makes/jaguar.png",
  JEEP: "/logos/makes/jeep.png",
  KIA: "/logos/makes/kia.png",
  LAMBORGHINI: "/logos/makes/lamborghini.png",
  "LAND ROVER": "/logos/makes/land-rover.png",
  LEXUS: "/logos/makes/lexus.png",
  LINCOLN: "/logos/makes/lincoln.png",
  LUCID: "/logos/makes/lucid.png",
  MASERATI: "/logos/makes/maserati.png",
  MAZDA: "/logos/makes/mazda.png",
  "MERCEDES-BENZ": "/logos/makes/mercedes-benz.png",
  MERCURY: "/logos/makes/mercury.png",
  MINI: "/logos/makes/mini.png",
  MITSUBISHI: "/logos/makes/mitsubishi.png",
  NISSAN: "/logos/makes/nissan.png",
  OLDSMOBILE: "/logos/makes/oldsmobile.png",
  PEUGEOT: "/logos/makes/peugeot.png",
  POLESTAR: "/logos/makes/polestar.png",
  PONTIAC: "/logos/makes/pontiac.png",
  PORSCHE: "/logos/makes/porsche.png",
  RAM: "/logos/makes/ram.png",
  "RANGE ROVER": "/logos/makes/range-rover.png",
  RENAULT: "/logos/makes/renault.png",
  RIVIAN: "/logos/makes/rivian.png",
  "ROLLS-ROYCE": "/logos/makes/rolls-royce.png",
  SAAB: "/logos/makes/saab.png",
  SATURN: "/logos/makes/saturn.png",
  SCION: "/logos/makes/scion.png",
  SMART: "/logos/makes/smart.png",
  SUBARU: "/logos/makes/subaru.png",
  SUZUKI: "/logos/makes/suzuki.png",
  TESLA: "/logos/makes/tesla.png",
  TOYOTA: "/logos/makes/toyota.png",
  VOLKSWAGEN: "/logos/makes/volkswagen.png",
  VOLVO: "/logos/makes/volvo.png",
};

/**
 * Aliases / common variants that map onto a canonical key in `OE_LOGO_MAP`.
 * Keys here are already uppercase + whitespace-collapsed, matching the
 * output of `normalizeMakeKey`'s pre-lookup form.
 */
export const OE_LOGO_ALIASES: Record<string, string> = {
  // Mercedes-Benz
  MERCEDES: "MERCEDES-BENZ",
  "MERCEDES BENZ": "MERCEDES-BENZ",
  MERCEDESBENZ: "MERCEDES-BENZ",
  "MERCEDES-BENZ AG": "MERCEDES-BENZ",
  "MERCEDES BENZ AG": "MERCEDES-BENZ",
  MB: "MERCEDES-BENZ",
  MERC: "MERCEDES-BENZ",

  // Land Rover / Range Rover
  "LAND-ROVER": "LAND ROVER",
  LANDROVER: "LAND ROVER",
  "RANGE-ROVER": "RANGE ROVER",
  RANGEROVER: "RANGE ROVER",

  // Volkswagen
  VW: "VOLKSWAGEN",
  "VOLKS WAGEN": "VOLKSWAGEN",
  VOLKSWAGON: "VOLKSWAGEN",

  // Mitsubishi
  "MITSUBISHI MOTORS": "MITSUBISHI",

  // Alfa Romeo
  "ALFA-ROMEO": "ALFA ROMEO",
  ALFAROMEO: "ALFA ROMEO",

  // Mini
  "MINI COOPER": "MINI",
  "MINI-COOPER": "MINI",

  // Chevrolet
  CHEVY: "CHEVROLET",

  // Rolls-Royce
  "ROLLS ROYCE": "ROLLS-ROYCE",
  ROLLSROYCE: "ROLLS-ROYCE",
};

/**
 * Normalize a free-form make string into the canonical `OE_LOGO_MAP` key,
 * resolving common aliases when possible. Returns the upper-cased input
 * unchanged if no alias matches; callers should still validate that the
 * returned key exists in `OE_LOGO_MAP`.
 */
export function normalizeMakeKey(make: string): string {
  const upper = make.toUpperCase().trim().replace(/\s+/g, " ");
  if (OE_LOGO_MAP[upper]) return upper;
  if (OE_LOGO_ALIASES[upper]) return OE_LOGO_ALIASES[upper];
  return upper;
}

/**
 * Resolve an OE logo URL for the given make. Returns null when no canonical
 * make or alias matches, so callers can omit the logo gracefully.
 */
export function getOELogoUrl(make: string | null | undefined): string | null {
  if (!make) return null;
  return OE_LOGO_MAP[normalizeMakeKey(make)] || null;
}
