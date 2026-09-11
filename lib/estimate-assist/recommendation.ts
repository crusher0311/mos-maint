/**
 * Client-safe Estimate Assist recommendation contract.
 *
 * Keep this entrypoint free of server dependencies so dashboard and extension
 * code can import the request/response/selection types without bundling the
 * resolver or provider adapters.
 */
export * from "./recommendation-types";
