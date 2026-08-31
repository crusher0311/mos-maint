const LIGHTWEIGHT_FEATURES = new Set(["oil_sticker", "keytags"]);

export interface FloatingDetectDogInput {
  effectiveFeatures?: Record<string, boolean> | null;
  ownerPreference?: boolean | null;
  userPreference?: boolean | null;
}

export function resolveFloatingDetectDog(input: FloatingDetectDogInput) {
  const enabledKeys = Object.entries(input.effectiveFeatures ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => key);
  const onlyStickerOrKeytags =
    enabledKeys.length > 0 && enabledKeys.every((key) => LIGHTWEIGHT_FEATURES.has(key));
  const ownerEnabled =
    typeof input.ownerPreference === "boolean"
      ? input.ownerPreference
      : !onlyStickerOrKeytags;
  const userPreference =
    typeof input.userPreference === "boolean" ? input.userPreference : null;

  return {
    ownerEnabled,
    userPreference,
    enabled: ownerEnabled && userPreference !== false,
  };
}