/**
 * Cloud-print payload limits. A 640x800 pilot JPEG is normally far below
 * 1 MiB; 4 MiB leaves ample headroom while bounding an unattended SYSTEM
 * process before base64 decode, JSON parse, or JPEG decode.
 */
export const MAX_JPEG_BYTES = 4 * 1024 * 1024;
export const MAX_ENCODED_IMAGE_CHARS = 4 * Math.ceil(MAX_JPEG_BYTES / 3);
export const MAX_IMAGE_INPUT_CHARS = MAX_ENCODED_IMAGE_CHARS + 128;
export const MAX_POLL_RESPONSE_BYTES = MAX_ENCODED_IMAGE_CHARS + 64 * 1024;
export const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;