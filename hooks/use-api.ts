import useSWR, { SWRConfiguration, KeyedMutator } from "swr";

interface UseApiOptions<T> extends SWRConfiguration<T> {
  enabled?: boolean;
}

interface UseApiReturn<T> {
  data: T | undefined;
  error: Error | undefined;
  isLoading: boolean;
  isValidating: boolean;
  mutate: KeyedMutator<T>;
}

export function useApi<T>(
  url: string | null,
  options: UseApiOptions<T> = {}
): UseApiReturn<T> {
  const { enabled = true, ...swrOptions } = options;

  const { data, error, isLoading, isValidating, mutate } = useSWR<T>(
    enabled && url ? url : null,
    swrOptions
  );

  return {
    data,
    error,
    isLoading,
    isValidating,
    mutate,
  };
}

export function useDashboardData(
  page: number,
  search: string,
  archived: boolean = false
) {
  const params = new URLSearchParams({
    page: page.toString(),
    pageSize: "100",
  });
  if (search) params.set("search", search);
  if (archived) params.set("archived", "true");

  return useApi(`/api/dashboard/data?${params}`, {
    revalidateOnFocus: false,
    dedupingInterval: 10000,
  });
}

export function useShopSettings() {
  return useApi("/api/shop/settings", {
    revalidateOnFocus: false,
    dedupingInterval: 30000,
  });
}

export function useStickerSettings() {
  return useApi("/api/sticker/settings", {
    revalidateOnFocus: false,
    dedupingInterval: 30000,
  });
}

export function useKeytagSettings() {
  return useApi("/api/keytag/settings", {
    revalidateOnFocus: false,
    dedupingInterval: 30000,
  });
}

export function useVehicleData(vin: string | null) {
  return useApi(vin ? `/api/vehicle/${vin}` : null, {
    revalidateOnFocus: false,
    dedupingInterval: 60000,
  });
}

export function useJobHistory(vin: string | null, shopId?: number) {
  const params = new URLSearchParams();
  if (shopId) params.set("shopId", shopId.toString());
  
  return useApi(
    vin ? `/api/vehicle/${vin}/jobs?${params}` : null,
    {
      revalidateOnFocus: false,
      dedupingInterval: 30000,
    }
  );
}

export function useEnterpriseLocations() {
  return useApi("/api/enterprise/locations", {
    revalidateOnFocus: false,
    dedupingInterval: 60000,
  });
}
