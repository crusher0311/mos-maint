export const OE_LOGO_MAP: Record<string, string> = {
  "ACURA": "/logos/makes/acura.png",
  "ALFA ROMEO": "/logos/makes/alfa-romeo.png",
  "AUDI": "/logos/makes/audi.png",
  "BENTLEY": "/logos/makes/bentley.png",
  "BMW": "/logos/makes/bmw.png",
  "BUICK": "/logos/makes/buick.png",
  "CADILLAC": "/logos/makes/cadillac.png",
  "CHEVROLET": "/logos/makes/chevrolet.png",
  "CHRYSLER": "/logos/makes/chrysler.png",
  "DODGE": "/logos/makes/dodge.png",
  "FERRARI": "/logos/makes/ferrari.png",
  "FIAT": "/logos/makes/fiat.png",
  "FORD": "/logos/makes/ford.png",
  "GENESIS": "/logos/makes/genesis.png",
  "GMC": "/logos/makes/gmc.png",
  "HONDA": "/logos/makes/honda.png",
  "HUMMER": "/logos/makes/hummer.png",
  "HYUNDAI": "/logos/makes/hyundai.png",
  "INFINITI": "/logos/makes/infiniti.png",
  "JAGUAR": "/logos/makes/jaguar.png",
  "JEEP": "/logos/makes/jeep.png",
  "KIA": "/logos/makes/kia.png",
  "LAMBORGHINI": "/logos/makes/lamborghini.png",
  "LAND ROVER": "/logos/makes/land-rover.png",
  "LEXUS": "/logos/makes/lexus.png",
  "LINCOLN": "/logos/makes/lincoln.png",
  "LUCID": "/logos/makes/lucid.png",
  "MASERATI": "/logos/makes/maserati.png",
  "MAZDA": "/logos/makes/mazda.png",
  "MERCEDES-BENZ": "/logos/makes/mercedes-benz.png",
  "MERCURY": "/logos/makes/mercury.png",
  "MINI": "/logos/makes/mini.png",
  "MITSUBISHI": "/logos/makes/mitsubishi.png",
  "NISSAN": "/logos/makes/nissan.png",
  "OLDSMOBILE": "/logos/makes/oldsmobile.png",
  "PEUGEOT": "/logos/makes/peugeot.png",
  "POLESTAR": "/logos/makes/polestar.png",
  "PONTIAC": "/logos/makes/pontiac.png",
  "PORSCHE": "/logos/makes/porsche.png",
  "RAM": "/logos/makes/ram.png",
  "RANGE ROVER": "/logos/makes/range-rover.png",
  "RENAULT": "/logos/makes/renault.png",
  "RIVIAN": "/logos/makes/rivian.png",
  "ROLLS-ROYCE": "/logos/makes/rolls-royce.png",
  "SAAB": "/logos/makes/saab.png",
  "SATURN": "/logos/makes/saturn.png",
  "SCION": "/logos/makes/scion.png",
  "SMART": "/logos/makes/smart.png",
  "SUBARU": "/logos/makes/subaru.png",
  "SUZUKI": "/logos/makes/suzuki.png",
  "TESLA": "/logos/makes/tesla.png",
  "TOYOTA": "/logos/makes/toyota.png",
  "VOLKSWAGEN": "/logos/makes/volkswagen.png",
  "VOLVO": "/logos/makes/volvo.png",
};

export const OE_LOGO_ALIASES: Record<string, string> = {
  "MERCEDES": "MERCEDES-BENZ",
  "MERCEDES BENZ": "MERCEDES-BENZ",
  "MERCEDES-BENZ AG": "MERCEDES-BENZ",
  "MB": "MERCEDES-BENZ",
  "RANGE-ROVER": "RANGE ROVER",
  "RANGEROVER": "RANGE ROVER",
  "LAND-ROVER": "LAND ROVER",
  "LANDROVER": "LAND ROVER",
  "VW": "VOLKSWAGEN",
  "VOLKS WAGEN": "VOLKSWAGEN",
  "MITSUBISHI MOTORS": "MITSUBISHI",
  "ALFA-ROMEO": "ALFA ROMEO",
  "ALFAROMEO": "ALFA ROMEO",
  "MINI COOPER": "MINI",
  "MINI-COOPER": "MINI",
  "CHEVY": "CHEVROLET",
  "MERC": "MERCEDES-BENZ",
};

function normalizeMakeKey(make: string): string {
  const upper = make.toUpperCase().trim().replace(/\s+/g, " ");
  if (OE_LOGO_MAP[upper]) return upper;
  if (OE_LOGO_ALIASES[upper]) return OE_LOGO_ALIASES[upper];
  return upper;
}

export function getOELogoUrl(make: string | null | undefined): string | null {
  if (!make) return null;
  return OE_LOGO_MAP[normalizeMakeKey(make)] || null;
}
