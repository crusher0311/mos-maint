// lib/auto-booking/holidays.ts
// Dynamic holiday calculation with rule-based definitions

export type HolidayRule = 
  | { type: "fixed"; month: number; day: number }
  | { type: "nth_weekday"; month: number; weekday: number; n: number }
  | { type: "last_weekday"; month: number; weekday: number };

export interface HolidayDefinition {
  id: string;
  name: string;
  rule: HolidayRule;
  observedRule?: "nearest_weekday";
}

export const DEFAULT_HOLIDAY_DEFINITIONS: HolidayDefinition[] = [
  {
    id: "new_years",
    name: "New Year's Day",
    rule: { type: "fixed", month: 1, day: 1 },
    observedRule: "nearest_weekday",
  },
  {
    id: "mlk_day",
    name: "Martin Luther King Jr. Day",
    rule: { type: "nth_weekday", month: 1, weekday: 1, n: 3 },
  },
  {
    id: "presidents_day",
    name: "Presidents' Day",
    rule: { type: "nth_weekday", month: 2, weekday: 1, n: 3 },
  },
  {
    id: "memorial_day",
    name: "Memorial Day",
    rule: { type: "last_weekday", month: 5, weekday: 1 },
  },
  {
    id: "independence_day",
    name: "Independence Day",
    rule: { type: "fixed", month: 7, day: 4 },
    observedRule: "nearest_weekday",
  },
  {
    id: "labor_day",
    name: "Labor Day",
    rule: { type: "nth_weekday", month: 9, weekday: 1, n: 1 },
  },
  {
    id: "columbus_day",
    name: "Columbus Day",
    rule: { type: "nth_weekday", month: 10, weekday: 1, n: 2 },
  },
  {
    id: "veterans_day",
    name: "Veterans Day",
    rule: { type: "fixed", month: 11, day: 11 },
    observedRule: "nearest_weekday",
  },
  {
    id: "thanksgiving",
    name: "Thanksgiving Day",
    rule: { type: "nth_weekday", month: 11, weekday: 4, n: 4 },
  },
  {
    id: "christmas",
    name: "Christmas Day",
    rule: { type: "fixed", month: 12, day: 25 },
    observedRule: "nearest_weekday",
  },
];

function getNthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const firstDay = new Date(year, month - 1, 1);
  let dayOffset = weekday - firstDay.getDay();
  if (dayOffset < 0) dayOffset += 7;
  
  const firstOccurrence = 1 + dayOffset;
  const nthOccurrence = firstOccurrence + (n - 1) * 7;
  
  return new Date(year, month - 1, nthOccurrence);
}

function getLastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const lastDay = new Date(year, month, 0);
  let dayOffset = lastDay.getDay() - weekday;
  if (dayOffset < 0) dayOffset += 7;
  
  return new Date(year, month - 1, lastDay.getDate() - dayOffset);
}

function getObservedDate(date: Date): Date {
  const dayOfWeek = date.getDay();
  if (dayOfWeek === 0) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  }
  if (dayOfWeek === 6) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
  }
  return date;
}

export function calculateHolidayDate(definition: HolidayDefinition, year: number): { actual: Date; observed?: Date } {
  let actualDate: Date;
  
  switch (definition.rule.type) {
    case "fixed":
      actualDate = new Date(year, definition.rule.month - 1, definition.rule.day);
      break;
    case "nth_weekday":
      actualDate = getNthWeekdayOfMonth(year, definition.rule.month, definition.rule.weekday, definition.rule.n);
      break;
    case "last_weekday":
      actualDate = getLastWeekdayOfMonth(year, definition.rule.month, definition.rule.weekday);
      break;
  }
  
  const result: { actual: Date; observed?: Date } = { actual: actualDate };
  
  if (definition.observedRule === "nearest_weekday") {
    const observed = getObservedDate(actualDate);
    if (observed.getTime() !== actualDate.getTime()) {
      result.observed = observed;
    }
  }
  
  return result;
}

export interface ComputedHoliday {
  id: string;
  name: string;
  date: string;
  isObserved: boolean;
  year: number;
}

export function generateHolidaysForYears(
  years: number[],
  enabledHolidays?: Record<string, boolean>
): ComputedHoliday[] {
  const holidays: ComputedHoliday[] = [];
  
  for (const year of years) {
    for (const def of DEFAULT_HOLIDAY_DEFINITIONS) {
      if (enabledHolidays && enabledHolidays[def.id] === false) {
        continue;
      }
      
      const { actual, observed } = calculateHolidayDate(def, year);
      
      holidays.push({
        id: def.id,
        name: def.name,
        date: formatDate(actual),
        isObserved: false,
        year,
      });
      
      if (observed) {
        holidays.push({
          id: def.id,
          name: `${def.name} (Observed)`,
          date: formatDate(observed),
          isObserved: true,
          year,
        });
      }
    }
  }
  
  return holidays.sort((a, b) => a.date.localeCompare(b.date));
}

export function getRelevantHolidayYears(): number[] {
  const now = new Date();
  const currentYear = now.getFullYear();
  return [currentYear, currentYear + 1];
}

export function getBlockedHolidayDates(
  enabledHolidays?: Record<string, boolean>
): Set<string> {
  const years = getRelevantHolidayYears();
  const holidays = generateHolidaysForYears(years, enabledHolidays);
  return new Set(holidays.map(h => h.date));
}

export function getHolidayDefinitionsWithStatus(
  enabledHolidays?: Record<string, boolean>
): Array<{ id: string; name: string; enabled: boolean }> {
  return DEFAULT_HOLIDAY_DEFINITIONS.map(def => ({
    id: def.id,
    name: def.name,
    enabled: enabledHolidays?.[def.id] !== false,
  }));
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getUpcomingHolidays(
  enabledHolidays?: Record<string, boolean>,
  limit: number = 12
): ComputedHoliday[] {
  const years = getRelevantHolidayYears();
  const holidays = generateHolidaysForYears(years, enabledHolidays);
  const today = formatDate(new Date());
  
  return holidays
    .filter(h => h.date >= today)
    .slice(0, limit);
}
