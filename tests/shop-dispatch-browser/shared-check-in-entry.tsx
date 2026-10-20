import React from "react";
import { createRoot } from "react-dom/client";
import NewWorkOrderModal from "../../components/NewWorkOrderModal";
import { createNewROFixture } from "./new-ro-fixture";

const params = new URLSearchParams(location.search);
params.set("newROShared", "");
const fixture = createNewROFixture(params, () => "offline-visit");
window.fetch = async (input, init) => {
  const response = await fixture(String(input), init);
  if (!response) throw new Error(`Offline check-in fixture blocked ${String(input)}`);
  return response;
};
createRoot(document.getElementById("root")!).render(<NewWorkOrderModal isOpen onClose={() => {}} requestedDraftId={params.get("draft") ?? undefined} />);
