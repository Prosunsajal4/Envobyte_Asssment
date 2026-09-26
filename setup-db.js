require("dotenv").config();
const mysql = require("mysql2/promise");

async function main() {
  const host = process.env.DB_HOST || "127.0.0.1";
  const port = Number(process.env.DB_PORT) || 3306;
  const user = process.env.DB_USER || "root";
  const password = process.env.DB_PASSWORD || "";
  const database = process.env.DB_NAME || "envobyte";

  const connection = await mysql.createConnection({ host, port, user, password });
  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await connection.end();
  console.log(`Database "${database}" is ready.`);
}

main().catch((err) => {
  console.error("MySQL setup failed:", err.code || err.message);
  process.exit(1);
});
