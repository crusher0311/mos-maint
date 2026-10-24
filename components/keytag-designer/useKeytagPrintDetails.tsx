"use client";

import { useEffect, useRef, useState } from "react";
import { Printer, X } from "lucide-react";
import type { DesignerLayout } from "@/lib/keytag-designer-types";
import { enabledKeytagExtras, keytagFieldBinding, KEYTAG_VALUE_MAX, normalizeKeytagExtraValues } from "@/lib/keytag-extra-fields";

type Operation = {
  controller: AbortController;
  shop: string;
  mobileWindow: Window | null;
  isCurrent: () => boolean;
};
type Details = {
  operation: Operation;
  fields: ReturnType<typeof enabledKeytagExtras>;
  layout: DesignerLayout;
  vehicle: string;
  resolve: (values: Record<string, string> | null) => void;
};

// Values are intentionally ephemeral: never cached, persisted, or shared between rows.
export function useKeytagPrintDetails(shop: string, onCancel: () => void) {
  const currentShop = useRef(shop);
  currentShop.current = shop;
  const active = useRef<Operation | null>(null);
  const cancelCallback = useRef(onCancel);
  cancelCallback.current = onCancel;
  const [details, setDetails] = useState<Details | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);

  const cancel = () => {
    const operation = active.current;
    active.current = null;
    operation?.controller.abort();
    if (operation?.mobileWindow && !operation.mobileWindow.closed) {
      try { operation.mobileWindow.close(); } catch { /* Browser may have closed it. */ }
    }
    setDetails(null);
    setValues({});
    cancelCallback.current();
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    return () => cancelRef.current();
  }, [shop]);
  useEffect(() => {
    if (!details) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelRef.current();
      if (event.key === "Tab") {
        const controls = formRef.current?.querySelectorAll<HTMLElement>("button, input");
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [details]);

  const begin = (mobileWindow: Window | null): Operation => {
    cancel();
    const operation: Operation = {
      controller: new AbortController(), shop, mobileWindow,
      isCurrent: () => active.current === operation && currentShop.current === operation.shop && !operation.controller.signal.aborted,
    };
    active.current = operation;
    return operation;
  };

  const collect = async (operation: Operation, row: any, vehicle: string) => {
    const response = await fetch("/api/keytag/settings", {
      cache: "no-store", credentials: "include", signal: operation.controller.signal,
    });
    if (!response.ok) throw new Error("Could not load keytag settings. Please try printing again.");
    const settings = await response.json();
    if (!operation.isCurrent()) return null;
    const layout: DesignerLayout | undefined = settings.config?.designerLayout;
    if (!layout) return {};
    const fields = enabledKeytagExtras(layout);
    if (!fields.length) return {};
    // Only projected row context is used; never look up a vehicle upstream.
    const text = (...candidates: unknown[]) => {
      const value = candidates.find(candidate => typeof candidate === "string" && candidate.trim());
      return typeof value === "string" ? value.slice(0, KEYTAG_VALUE_MAX) : "";
    };
    const initial = normalizeKeytagExtraValues(layout, {
      vehicleColor: text(row?.vehicle?.color, row?.vehicle?.vehicleColor, row?.vehicleColor, row?.color, row?.displayColor),
      licensePlate: text(row?.vehicle?.licensePlate, row?.vehicle?.plate, row?.licensePlate, row?.plate, row?.displayPlate),
    });
    setValues(initial);
    return new Promise<Record<string, string> | null>(resolve => {
      const onAbort = () => resolve(null);
      operation.controller.signal.addEventListener("abort", onAbort, { once: true });
      setDetails({
        operation, fields, layout, vehicle,
        resolve: result => {
          operation.controller.signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
      });
    });
  };

  const dialog = details && details.operation.isCurrent() ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={cancel}>
      <form ref={formRef} role="dialog" aria-modal="true" aria-labelledby="keytag-details-title"
        onClick={event => event.stopPropagation()}
        onSubmit={event => {
          event.preventDefault();
          if (!details.operation.isCurrent()) return;
          details.resolve(normalizeKeytagExtraValues(details.layout, values));
          setDetails(null);
          setValues({});
        }}
        className="max-h-[90dvh] w-full max-w-sm overflow-y-auto rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 id="keytag-details-title" className="text-lg font-semibold text-gray-900">Keytag details</h2>
          <button type="button" onClick={cancel} aria-label="Cancel keytag printing" className="rounded-lg p-2 text-gray-400 hover:bg-gray-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="space-y-4 p-6">
          <p className="text-sm text-gray-500">{details.vehicle || "Vehicle"} — all details are optional and apply only to this print.</p>
          {details.fields.map(field => {
            const binding = keytagFieldBinding(field);
            return (
              <div key={binding}>
                <label htmlFor={`keytag-${binding}`} className="mb-1 block text-sm font-medium text-gray-700">{field.label || "Custom field"}</label>
                <input id={`keytag-${binding}`} autoComplete="off" maxLength={KEYTAG_VALUE_MAX}
                  value={values[binding] || ""} onChange={event => setValues(previous => ({ ...previous, [binding]: event.target.value.slice(0, KEYTAG_VALUE_MAX) }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500" />
              </div>
            );
          })}
        </div>
        <div className="flex justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={cancel} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">Cancel</button>
          <button type="submit" className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"><Printer className="h-4 w-4" />Print keytag</button>
        </div>
      </form>
    </div>
  ) : null;
  return { begin, collect, dialog };
}
