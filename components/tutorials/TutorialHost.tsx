"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { createTutorials, type TutorialContext, type TutorialController } from "@/mos-tools-extension/tutorials";

export function openTutorials() {
  window.dispatchEvent(new Event("mos:open-tutorials"));
}

export function TutorialLink() {
  return <button type="button" className="mos-help-link" onClick={openTutorials}>How this works</button>;
}

export default function TutorialHost({ identity, enabledFeatures, authenticated }: {
  identity: string;
  enabledFeatures: string[];
  authenticated: boolean;
}) {
  const pathname = usePathname() || "";
  const controller = useRef<TutorialController | null>(null);
  const current = pathname.includes("/jobs") || pathname.includes("canned-jobs") ? "jobs"
    : /stickers|keytags/.test(pathname) ? "printing"
    : /\/(?:vehicles|analyzer)\//.test(pathname) ? "vhi" : null;
  const context = useRef<TutorialContext>({ authenticated, features: enabledFeatures, current, scope: "" });
  context.current = { authenticated, features: enabledFeatures, current, scope: `${identity}|${pathname}` };
  useEffect(() => {
    const instance = createTutorials({
      surface: "web",
      getContext: () => context.current,
      request: async (method, body) => {
        const response = await fetch("/api/tutorials", {
          method, credentials: "include", cache: "no-store",
          ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) throw new Error("Tutorial preferences unavailable");
        return response.json();
      },
    });
    controller.current = instance;
    const open = () => instance.open();
    // Account/scope transitions invalidate pending requests before navigation.
    const invalidate = () => instance.reset();
    window.addEventListener("mos:open-tutorials", open);
    window.addEventListener("mos:tutorial-scope-changing", invalidate);
    return () => {
      window.removeEventListener("mos:open-tutorials", open);
      window.removeEventListener("mos:tutorial-scope-changing", invalidate);
      instance.destroy(); controller.current = null;
    };
  }, []);
  useEffect(() => { controller.current?.sync(); }, [identity, pathname, authenticated, enabledFeatures]);
  return current && authenticated ? <div className="mos-help-context"><TutorialLink /></div> : null;
}
