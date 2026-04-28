/**
 * OE (Original Equipment) make-logo lookup for the Vehicle Health Report.
 *
 * Real-world shop / DMS data uses a wide variety of spellings, abbreviations
 * and aliases for the same vehicle make (e.g. `MERCEDES`, `MERCEDES BENZ`,
 * `MERCEDES-BENZ AG` all mean Mercedes-Benz). The canonical map keys here
 * match the asset filenames under `public/logos/makes/`. The alias map and
 * `normalizeMakeKey` together fold common variants — diacritics, corporate
 * suffixes ("AG", "Motor Company"), trim/series suffixes ("BMW M3"),
 * hyphen/space variants — onto those canonical keys so the lookup resolves a
 * logo instead of rendering nothing. Unknown makes still return `null`.
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
 * intermediate output of `normalizeMakeKey` before lookup.
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
  "ALPHA ROMEO": "ALFA ROMEO",

  // Mini
  "MINI COOPER": "MINI",
  "MINI-COOPER": "MINI",
  MINICOOPER: "MINI",

  // Chevrolet
  CHEVY: "CHEVROLET",
  CHEV: "CHEVROLET",

  // Rolls-Royce
  "ROLLS ROYCE": "ROLLS-ROYCE",
  ROLLSROYCE: "ROLLS-ROYCE",

  // BMW
  BEEMER: "BMW",
  BIMMER: "BMW",

  // Common misspellings
  INFINITY: "INFINITI",
  PORCHE: "PORSCHE",
  HUNDAI: "HYUNDAI",
  HYUNDIA: "HYUNDAI",
};

/**
 * Corporate / legal-entity suffixes commonly appended to a make in DMS data
 * (e.g. "Porsche AG", "Ford Motor Company", "Honda of America"). They are
 * stripped from the end of the normalized key, repeatedly, before each
 * lookup attempt.
 */
const SUFFIX_STRIP_PATTERNS: RegExp[] = [
  /\s+MOTOR\s+COMPANY$/,
  /\s+MOTOR\s+CORPORATION$/,
  /\s+MOTOR\s+CORP\.?$/,
  /\s+MOTOR\s+CO\.?$/,
  /\s+MOTORS$/,
  /\s+AUTOMOBILES?$/,
  /\s+OF\s+AMERICA$/,
  /\s+NORTH\s+AMERICA$/,
  /\s+USA$/,
  /\s+AG$/,
  /\s+SA$/,
  /\s+S\.A\.?$/,
  /\s+GMBH$/,
  /\s+INC\.?$/,
  /\s+LTD\.?$/,
  /\s+LLC$/,
  /\s+CO\.?$/,
  /\s+CORP\.?$/,
  /\s+CORPORATION$/,
  /\s+GROUP$/,
  /\s+BRAND$/,
];

/**
 * Try the canonical map and the alias map for an already-normalized key,
 * including hyphen/space variant swaps so callers don't need a per-variant
 * alias for every "Land Rover" / "LAND-ROVER" / "Rolls Royce" / "ROLLS-ROYCE"
 * spelling. Returns the canonical map key when found, otherwise null.
 */
function lookupKey(key: string): string | null {
  if (OE_LOGO_MAP[key]) return key;
  if (OE_LOGO_ALIASES[key]) return OE_LOGO_ALIASES[key];
  if (key.includes(" ")) {
    const hyphenated = key.replace(/ /g, "-");
    if (OE_LOGO_MAP[hyphenated]) return hyphenated;
    if (OE_LOGO_ALIASES[hyphenated]) return OE_LOGO_ALIASES[hyphenated];
  }
  if (key.includes("-")) {
    const spaced = key.replace(/-/g, " ");
    if (OE_LOGO_MAP[spaced]) return spaced;
    if (OE_LOGO_ALIASES[spaced]) return OE_LOGO_ALIASES[spaced];
  }
  return null;
}

/**
 * Normalize a free-form make string into the canonical `OE_LOGO_MAP` key,
 * resolving common aliases when possible. The pipeline is:
 *   1. NFD-normalize and strip diacritics ("Citroën" -> "CITROEN").
 *   2. Uppercase, trim, normalize punctuation/whitespace.
 *   3. Direct + hyphen/space variant lookup.
 *   4. Repeatedly strip corporate suffixes ("Porsche AG", "Ford Motor Co")
 *      and re-look up after each strip.
 *   5. Progressively strip trailing trim/series tokens ("BMW M3" -> "BMW",
 *      "Range Rover Sport" -> "RANGE ROVER") and re-look up. The shortened
 *      form is only returned when it matches a known make/alias, so unknown
 *      makes still fall through.
 *
 * Returns the upper-cased input unchanged if no match is found; callers
 * should still validate that the returned key exists in `OE_LOGO_MAP`.
 */
export function normalizeMakeKey(make: string): string {
  let key = make
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim()
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ");

  let resolved = lookupKey(key);
  if (resolved) return resolved;

  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of SUFFIX_STRIP_PATTERNS) {
      if (pattern.test(key)) {
        key = key.replace(pattern, "").trim();
        changed = true;
        resolved = lookupKey(key);
        if (resolved) return resolved;
      }
    }
  }

  const parts = key.split(" ");
  while (parts.length > 1) {
    parts.pop();
    const candidate = parts.join(" ");
    resolved = lookupKey(candidate);
    if (resolved) return resolved;
  }

  return key;
}

/**
 * Resolve an OE logo URL for the given make. Returns null when no canonical
 * make or alias matches, so callers can omit the logo gracefully.
 */
export function getOELogoUrl(make: string | null | undefined): string | null {
  if (!make) return null;
  return OE_LOGO_MAP[normalizeMakeKey(make)] || null;
}
