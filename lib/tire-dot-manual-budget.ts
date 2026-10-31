/** Operator-only, process-local allowance. Never changes the normal schedule. */
export function createTirePilotManualBudget(args: string[], now: () => Date) {
  if (!args.includes("--daytime-once")) return undefined;
  const started = now().getTime();
  const deadline = started + 15 * 60_000;
  let used = 0;
  return {
    available() { return now().getTime() >= started && now().getTime() < deadline && used < 20; },
    admit() {
      if (!this.available()) throw Error("window_manual_limit");
      used++;
    },
    get requests() { return used; },
  };
}
