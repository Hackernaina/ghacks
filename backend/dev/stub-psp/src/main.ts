import { buildStubPsp, type Faults } from "./server.js";

const pspId = process.env.PSP_ID === "psp_b" ? "psp_b" : "psp_a";
const port = Number(process.env.PORT ?? (pspId === "psp_a" ? 4001 : 4002));
const faults = process.env.FAULTS ? (JSON.parse(process.env.FAULTS) as Partial<Faults>) : {};

const stub = buildStubPsp({
  pspId,
  webhookSecret: process.env.WEBHOOK_SECRET ?? (pspId === "psp_a" ? "dev-secret-psp-a" : "dev-secret-psp-b"),
  callbackUrl: process.env.CALLBACK_URL ?? "http://localhost:3000",
  faults,
  logger: true,
});

stub.app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  stub.app.log.error(err);
  process.exit(1);
});
