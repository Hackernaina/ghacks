import { loadConfig } from "../config/index.js";
import { getPool, closePool } from "./pool.js";
import { logger } from "../logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = getPool(config);

  const seedOrders = [
    { customerId: "cust_1", amount: 150000, currency: "INR" },
    { customerId: "cust_2", amount: 250000, currency: "INR" },
    { customerId: "cust_3", amount: 99900, currency: "INR" },
  ];

  for (const order of seedOrders) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO orders (customer_id, amount, currency) VALUES ($1, $2, $3) RETURNING id`,
      [order.customerId, order.amount, order.currency],
    );
    logger.info({ orderId: rows[0]?.id, ...order }, "seeded order");
  }

  await closePool();
}

main().catch((err) => {
  logger.error({ err }, "seed failed");
  process.exit(1);
});
