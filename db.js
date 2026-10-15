const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const DB_NAME = process.env.DB_NAME || 'kstu_orders';

// Online MySQL (Aiven) needs an encrypted connection: set DB_SSL=true and give
// Aiven's CA certificate as a file (DB_SSL_CA_FILE) or as text (DB_SSL_CA).
const sslConfig = () => {
  if (process.env.DB_SSL !== 'true') {
    return {};
  }
  let ca;
  if (process.env.DB_SSL_CA_FILE) {
    ca = fs.readFileSync(path.resolve(__dirname, process.env.DB_SSL_CA_FILE), 'utf8');
  } else if (process.env.DB_SSL_CA) {
    ca = process.env.DB_SSL_CA.replace(/\\n/g, '\n');
  }
  return { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true, ...(ca ? { ca } : {}) } };
};

const connectionConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  ...sslConfig(),
};

let pool = null;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS orders (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    customer_name VARCHAR(150) NOT NULL,
    email VARCHAR(190) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    address VARCHAR(500) NOT NULL,
    city VARCHAR(100) NOT NULL,
    country VARCHAR(100) NOT NULL DEFAULT 'Pakistan',
    remarks TEXT NULL,
    shipping_method VARCHAR(150) NULL,
    subtotal DECIMAL(12, 2) NOT NULL DEFAULT 0,
    item_count INT UNSIGNED NOT NULL DEFAULT 0,
    status ENUM('new', 'confirmed', 'shipped', 'delivered', 'cancelled') NOT NULL DEFAULT 'new',
    wants_emails TINYINT(1) NOT NULL DEFAULT 0,
    email_sent TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_orders_created (created_at),
    INDEX idx_orders_status (status),
    INDEX idx_orders_city (city),
    INDEX idx_orders_phone (phone),
    INDEX idx_orders_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS order_items (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id INT UNSIGNED NOT NULL,
    title VARCHAR(255) NOT NULL,
    sku VARCHAR(100) NULL,
    size VARCHAR(50) NULL,
    collection VARCHAR(100) NULL,
    quantity INT UNSIGNED NOT NULL DEFAULT 1,
    unit_price DECIMAL(12, 2) NOT NULL DEFAULT 0,
    line_total DECIMAL(12, 2) NOT NULL DEFAULT 0,
    INDEX idx_items_order (order_id),
    INDEX idx_items_collection (collection),
    CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS discounts (
    collection VARCHAR(50) NOT NULL PRIMARY KEY,
    percent TINYINT UNSIGNED NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

// Creates the database and tables if they don't exist yet, then opens the pool.
// Returns null (and logs why) when MySQL can't be reached, so the server can
// still email orders without a database.
async function initDatabase() {
  try {
    const setup = await mysql.createConnection(connectionConfig);
    await setup.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await setup.end();

    pool = mysql.createPool({
      ...connectionConfig,
      database: DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      decimalNumbers: true,
      dateStrings: true,
    });

    // Aiven runs on UTC; keep order times (and date filters) in Pakistan time
    const timeZone = process.env.DB_TIMEZONE || '+05:00';
    pool.pool.on('connection', (conn) => {
      conn.query(`SET time_zone = '${timeZone.replace(/[^+\-\d:]/g, '')}'`);
    });

    for (const statement of TABLES) {
      await pool.query(statement);
    }
    await addMissingColumns();

    console.log(`MySQL connected: database "${DB_NAME}" is ready.`);
    return pool;
  } catch (err) {
    pool = null;
    console.error(`MySQL not available (${err.code || err.message}). Orders will only be emailed.`);
    return null;
  }
}

// Columns added after the orders table first went live
const NEW_ORDER_COLUMNS = {
  bank_name: 'VARCHAR(100) NULL AFTER remarks',
  reference_no: 'VARCHAR(100) NULL AFTER bank_name',
  deposit_slip: 'MEDIUMBLOB NULL AFTER reference_no',
  deposit_slip_type: 'VARCHAR(50) NULL AFTER deposit_slip',
};

async function addMissingColumns() {
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [DB_NAME, 'orders']
  );
  const existing = new Set(rows.map((row) => row.COLUMN_NAME));
  for (const [name, definition] of Object.entries(NEW_ORDER_COLUMNS)) {
    if (!existing.has(name)) {
      await pool.query(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`);
    }
  }
}

function getPool() {
  return pool;
}

module.exports = { initDatabase, getPool };
