require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

async function ensureColumns(connection) {
  const [subscriptionColumns] = await connection.query(
    "SHOW COLUMNS FROM subscriptions"
  );
  const hasLastEventAt = subscriptionColumns.some((column) => column.Field === "last_event_at");

  if (!hasLastEventAt) {
    await connection.query(
      "ALTER TABLE subscriptions ADD COLUMN last_event_at DATETIME NULL AFTER expires_at"
    );
  }

  const [paymentEventColumns] = await connection.query(
    "SHOW COLUMNS FROM payment_events"
  );
  const hasProcessedAt = paymentEventColumns.some((column) => column.Field === "processed_at");

  if (!hasProcessedAt) {
    await connection.query(
      "ALTER TABLE payment_events ADD COLUMN processed_at DATETIME NULL AFTER payload"
    );
  }
}

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });

  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await connection.query(sql);
  await ensureColumns(connection);

  const [tables] = await connection.query("SHOW TABLES");
  await connection.end();

  const names = tables.map((row) => Object.values(row)[0]);
  console.log("Tables:", names.join(", ") || "(none)");
}

main().catch((err) => {
  console.error("Migration failed:", err.code || err.message);
  process.exit(1);
});
