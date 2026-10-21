import { MAX_PHOTO_BYTES, photoAllowed } from "./ro-session-store";

/** Normalize large camera images before assigning a durable upload identity. */
export async function prepareROPhoto(file: File): Promise<File> {
  if (!file.size) throw new Error("This photo is empty. Please take it again.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("This photo format is not supported. Choose JPEG, PNG or WebP. On iPhone, use Camera → Formats → Most Compatible, then take a new photo.");
  if (photoAllowed(file)) return file;
  if (file.size > 40 * 1024 * 1024) throw new Error("This photo exceeds 40 MB. Choose a smaller photo.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 2560 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Photo processing is unavailable. Choose a smaller JPEG.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.9, 0.75, 0.6]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= MAX_PHOTO_BYTES && blob.size > 0)
        return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
    }
    throw new Error("The photo is still too large after resizing. Choose a smaller photo.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
