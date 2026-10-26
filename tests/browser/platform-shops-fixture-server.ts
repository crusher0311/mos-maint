// Compatibility entry point for the standalone offline browser fixture.
import { pathToFileURL } from "node:url";
import { createBoundedFixture } from "../../app/platform-admin/shops/bounded-loading-fixture";

export const createShopsFixture = createBoundedFixture;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] || 8099);
  createShopsFixture().then(f => f.server.listen(port, "0.0.0.0", () => console.log(`Offline All Shops ready on ${port}`)));
}
