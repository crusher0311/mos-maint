import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongo";
import { isIdentityPgCanonical } from "@/lib/db/wave4-write-mode";
import { readTutorialPreferences, writeTutorialPreference } from "@/lib/data/repositories/pg/identity";
import { tutorialPreferenceKey, tutorialState, type TutorialAction } from "@/lib/tutorial-preferences";

export const tutorialStoreDeps = { getDb, isIdentityPgCanonical, readTutorialPreferences, writeTutorialPreference };

/** Identity is always obtained from authenticated server state, never a shop or email. */
export async function personalTutorialPreferences(personId: string, action?: TutorialAction) {
  const key = action ? tutorialPreferenceKey(action) : null;
  let raw: unknown;
  let showNotice = false;
  if (tutorialStoreDeps.isIdentityPgCanonical()) {
    if (key) showNotice = await tutorialStoreDeps.writeTutorialPreference(personId, key);
    raw = await tutorialStoreDeps.readTutorialPreferences(personId);
  } else {
    const db = await tutorialStoreDeps.getDb();
    const ids = ObjectId.isValid(personId) ? [personId, new ObjectId(personId)] : [personId];
    const filter = { _id: { $in: ids } } as any;
    const collection = db.collection("users");
    if (key) {
      const result = await collection.updateOne(
        { ...filter, ...(key === "noticeSeen" ? { "tutorialPreferences.noticeSeen": { $ne: true } } : {}) },
        { $set: { [`tutorialPreferences.${key}`]: true } },
      );
      showNotice = key === "noticeSeen" && result.modifiedCount === 1;
    }
    const user = await collection.findOne(filter, { projection: { tutorialPreferences: 1 } });
    if (!user) throw new Error("Tutorial identity no longer exists");
    raw = user.tutorialPreferences;
  }
  return { state: tutorialState(raw), ...(action?.action === "notice" ? { showNotice } : {}) };
}
