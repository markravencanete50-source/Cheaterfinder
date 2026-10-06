import { scrapeProfile } from "../ig-public-scraper.js";

scrapeProfile("wire.fluid").then(p => {
  console.log("OK", JSON.stringify(p, null, 2).slice(0, 600));
  process.exit(0);
}).catch((err: any) => {
  console.error("FAIL:", err.message);
  console.error("cause-1:", err.cause?.message ?? err.cause);
  console.error("cause-2:", err.cause?.cause?.message ?? err.cause?.cause);
  console.error("cause-3:", err.cause?.cause?.cause?.message ?? err.cause?.cause?.cause);
  console.error("cause-cause-cause-cause:", err.cause?.cause?.cause?.cause?.message ?? err.cause?.cause?.cause?.cause);
  console.error("stack:", err.stack?.split("\n").slice(0, 6).join("\n"));
  process.exit(1);
});
