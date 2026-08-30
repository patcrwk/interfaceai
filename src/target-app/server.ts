import express from "express";
import modernRouter from "./modern/router.js";
import legacyRouter from "./legacy/router.js";
import { resetStore } from "./business.js";

export function createTargetApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get("/", (_req, res) => {
    res.send(
      `<!doctype html><html><body style="font-family:sans-serif">
        <h1>Credit Union Back-Office (demo target)</h1>
        <p><a href="/modern/">Modern variant</a> (clean DOM, for DomSurface)</p>
        <p><a href="/legacy/">Legacy variant</a> (no clean DOM, for VisionSurface)</p>
      </body></html>`
    );
  });

  // Internal-only reset hook so tests / the discovery CLI can start each run
  // from a known state. Not part of the "product" — a real back office
  // obviously wouldn't expose this.
  app.post("/__reset", (_req, res) => {
    resetStore();
    res.status(204).end();
  });

  app.use("/modern", modernRouter);
  app.use("/legacy", legacyRouter);

  return app;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT ?? 4173);
  const app = createTargetApp();
  app.listen(port, () => {
    console.log(`Target app listening on http://localhost:${port}`);
    console.log(`  Modern: http://localhost:${port}/modern/`);
    console.log(`  Legacy: http://localhost:${port}/legacy/`);
  });
}
