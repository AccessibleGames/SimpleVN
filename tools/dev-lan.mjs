/**
 * Dev server for a phone on the same network.
 *
 * The tilt camera needs `deviceorientation`, which browsers only expose in a
 * secure context. Plain http:// on a LAN address is not one, so this serves
 * HTTPS with a self-signed certificate and prints the exact URLs to open.
 *
 * The certificate is generated at start-up, so the phone will show a warning
 * once per browser; accepting it still yields a secure context.
 */
import { createServer } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

const port = Number(process.env.PORT ?? 5173);

const server = await createServer({
  plugins: [basicSsl()],
  server: { host: true, port, strictPort: false },
});

await server.listen();

const urls = server.resolvedUrls;
const network = urls?.network ?? [];

console.log("\n  local :", urls?.local?.join(" "));
for (const url of network) console.log("  phone :", url);
if (network.length === 0) {
  console.log("  phone : no LAN address found; check the network adapter");
}
console.log("\n  The certificate is self-signed: accept the warning once per device.");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
