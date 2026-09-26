require("dotenv").config();
const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("./db");

const app = express();
app.use(express.json());

function sendError(res, status, message, details = null) {
  return res.status(status).json({
    error: {
      message,
      ...(details ? { details } : {}),
    },
  });
}


function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseDate(value, fieldName) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid ISO date`);
  }
  return date;
}

function normalizeEventStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["paid", "active", "renewed", "purchase", "trial_started", "trial"].includes(normalized)) return "active";
  if (["cancelled", "canceled", "cancel", "ended", "subscription_ended"].includes(normalized)) return "cancelled";
  if (["expired", "expiration", "expired_subscription"].includes(normalized)) return "expired";
  return normalized || "active";
}

function pickExpiry(body, fallback) {
  const candidate = [body.expires_at, body.expiration_time, body.expire_at].find(
    (value) => value !== undefined && value !== null && value !== ""
  );
  return candidate ? new Date(candidate) : fallback;
}

function toPublicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

app.get("/health", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 AS ok");
    res.json({ status: "ok", db: rows[0].ok });
  } catch (err) {
    sendError(res, 500, err.message || err.code || "Database connection failed");
  }
});


app.post("/api/users", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || typeof name !== "string" || name.trim().length < 2) {
      return sendError(res, 400, "Name is required and must be at least 2 characters");
    }

    if (!email || typeof email !== "string" || !isValidEmail(email)) {
      return sendError(res, 400, "A valid email address is required");
    }

    if (!password || typeof password !== "string" || password.length < 8) {
      return sendError(res, 400, "Password is required and must be at least 8 characters");
    }

    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
      [name.trim(), email.trim().toLowerCase(), hash]
    );

    const [rows] = await pool.query(
      "SELECT id, name, email, created_at, updated_at FROM users WHERE id = ? LIMIT 1",
      [result.insertId]
    );

    return res.status(201).json({
      message: "User created successfully",
      data: toPublicUser(rows[0]),
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return sendError(res, 409, "User with this email already exists");
    }
    return sendError(res, 500, err.message || "Unable to create user");
  }
});

app.post("/api/subscriptions", async (req, res) => {
  try {
    const { user_id, provider, external_id, status, starts_at, expires_at } = req.body || {};

    if (!user_id || Number.isNaN(Number(user_id))) {
      return sendError(res, 400, "user_id is required");
    }

    if (!provider || typeof provider !== "string") {
      return sendError(res, 400, "provider is required");
    }

    if (!external_id || typeof external_id !== "string") {
      return sendError(res, 400, "external_id is required");
    }

    if (!status || typeof status !== "string") {
      return sendError(res, 400, "status is required");
    }

    const [userRows] = await pool.query("SELECT id FROM users WHERE id = ? LIMIT 1", [user_id]);
    if (!userRows.length) {
      return sendError(res, 404, "User not found");
    }

    const starts = parseDate(starts_at, "starts_at");
    const expires = parseDate(expires_at, "expires_at");
    if (expires <= starts) {
      return sendError(res, 400, "expires_at must be after starts_at");
    }

    const normalizedProvider = provider.trim().toLowerCase();
    const normalizedStatus = String(status).trim().toLowerCase();
    const startsSql = starts.toISOString().slice(0, 19).replace("T", " ");
    const expiresSql = expires.toISOString().slice(0, 19).replace("T", " ");

    const [result] = await pool.query(
      `INSERT INTO subscriptions (user_id, provider, external_id, status, starts_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         starts_at = VALUES(starts_at),
         expires_at = VALUES(expires_at),
         updated_at = CURRENT_TIMESTAMP`,
      [user_id, normalizedProvider, external_id.trim(), normalizedStatus, startsSql, expiresSql]
    );

    const [saved] = await pool.query(
      "SELECT id, user_id, provider, external_id, status, starts_at, expires_at, created_at, updated_at FROM subscriptions WHERE user_id = ? AND provider = ? AND external_id = ? LIMIT 1",
      [user_id, normalizedProvider, external_id.trim()]
    );

    return res.status(result.affectedRows === 0 ? 200 : 201).json({
      message: result.affectedRows === 0 ? "Subscription already existed" : "Subscription saved successfully",
      data: saved[0],
    });
  } catch (err) {
    return sendError(res, 500, err.message || "Unable to save subscription");
  }
});

app.post("/api/payment-events", async (req, res) => {
  try {
    const { provider, subscription_id, external_subscription_id, external_event_id, event_type, event_time, payload } = req.body || {};

    if (!provider || typeof provider !== "string") {
      return sendError(res, 400, "provider is required");
    }

    if (!external_event_id || typeof external_event_id !== "string") {
      return sendError(res, 400, "external_event_id is required");
    }

    if (!event_type || typeof event_type !== "string") {
      return sendError(res, 400, "event_type is required");
    }

    const normalizedProvider = provider.trim().toLowerCase();
    const normalizedEventType = normalizeEventStatus(event_type);

    let resolvedSubscriptionId = subscription_id;

    if (!resolvedSubscriptionId && external_subscription_id) {
      const [subRows] = await pool.query(
        "SELECT id FROM subscriptions WHERE provider = ? AND external_id = ? LIMIT 1",
        [normalizedProvider, external_subscription_id]
      );
      if (!subRows.length) {
        return sendError(res, 404, "Subscription not found for the provided provider event");
      }
      resolvedSubscriptionId = subRows[0].id;
    }

    if (!resolvedSubscriptionId) {
      return sendError(res, 400, "subscription_id or external_subscription_id is required");
    }

    const [subscriptionRows] = await pool.query(
      "SELECT id, status, expires_at, last_event_at FROM subscriptions WHERE id = ? LIMIT 1",
      [resolvedSubscriptionId]
    );
    if (!subscriptionRows.length) {
      return sendError(res, 404, "Subscription not found");
    }

    const eventDate = parseDate(event_time || new Date().toISOString(), "event_time");
    const currentLastEventAt = subscriptionRows[0].last_event_at ? new Date(subscriptionRows[0].last_event_at) : null;

    if (currentLastEventAt && eventDate < currentLastEventAt) {
      return res.status(200).json({ message: "Duplicate or stale payment event ignored", data: null });
    }

    const [existingEventRows] = await pool.query(
      "SELECT id FROM payment_events WHERE provider = ? AND external_event_id = ? LIMIT 1",
      [normalizedProvider, external_event_id.trim()]
    );
    if (existingEventRows.length) {
      return res.status(200).json({ message: "Duplicate payment event ignored", data: existingEventRows[0] });
    }

    const payloadValue = payload && typeof payload === "object" ? payload : {};
    const nextExpiry = pickExpiry(req.body, new Date(eventDate.getTime() + 30 * 24 * 60 * 60 * 1000));

    await pool.query(
      "INSERT INTO payment_events (subscription_id, provider, external_event_id, event_type, payload, processed_at) VALUES (?, ?, ?, ?, ?, NOW())",
      [resolvedSubscriptionId, normalizedProvider, external_event_id.trim(), normalizedEventType, JSON.stringify(payloadValue)]
    );

    if (["active", "cancelled", "expired"].includes(normalizedEventType)) {
      const nextStatus = normalizedEventType === "active" ? "active" : normalizedEventType;
      const nextExpiresAt = normalizedEventType === "active"
        ? nextExpiry.toISOString().slice(0, 19).replace("T", " ")
        : eventDate.toISOString().slice(0, 19).replace("T", " ");

      await pool.query(
        "UPDATE subscriptions SET status = ?, expires_at = ?, last_event_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [nextStatus, nextExpiresAt, eventDate.toISOString().slice(0, 19).replace("T", " "), resolvedSubscriptionId]
      );
    }

    return res.status(201).json({
      message: "Payment event recorded successfully",
      data: {
        provider: normalizedProvider,
        external_event_id: external_event_id.trim(),
        event_type: normalizedEventType,
      },
    });
  } catch (err) {
    return sendError(res, 500, err.message || "Unable to process payment event");
  }
});

app.get("/api/users/:id/entitlement", async (req, res) => {
  try {
    const userId = Number(req.params.id);

    if (!userId) {
      return sendError(res, 400, "User id is required");
    }

    const [userRows] = await pool.query("SELECT id FROM users WHERE id = ? LIMIT 1", [userId]);
    if (!userRows.length) {
      return sendError(res, 404, "User not found");
    }

    const [rows] = await pool.query(
      "SELECT id, user_id, status, expires_at FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC, expires_at DESC",
      [userId]
    );

    const activeSubscription = rows.find((subscription) => {
      const expiry = new Date(subscription.expires_at);
      const status = String(subscription.status || "").toLowerCase();
      return status === "active" && Number.isFinite(expiry.getTime()) && expiry > new Date();
    }) || null;

    return res.json({
      user_id: userId,
      entitled: Boolean(activeSubscription),
      active_subscription: activeSubscription,
    });
  } catch (err) {
    return sendError(res, 500, err.message || "Unable to determine entitlement");
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  sendError(res, 500, "Unexpected server error");
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

module.exports = { app };

