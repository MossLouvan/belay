-- Per-account opt-out for security alert emails (new sign-in, phone, computer,
-- phone approval request). On by default.
ALTER TABLE accounts ADD COLUMN security_emails INTEGER NOT NULL DEFAULT 1;
