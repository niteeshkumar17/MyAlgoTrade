-- ============================================================================
-- 002_roles_and_permissions.sql
-- Least-Privilege Database Role Separation:
--   1. bot_rw : Full read/write access used ONLY by the Oracle Cloud VM bot
--   2. web_ro : Read-only across all tables, plus UPDATE on `control` ONLY
--               so the Vercel website can never place, modify, or cancel orders.
--
-- Usage: Replace STRONG_BOT_PASSWORD and STRONG_WEB_PASSWORD before running.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'bot_rw') THEN
        CREATE ROLE bot_rw WITH LOGIN PASSWORD 'REPLACE_WITH_STRONG_BOT_PASSWORD';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'web_ro') THEN
        CREATE ROLE web_ro WITH LOGIN PASSWORD 'REPLACE_WITH_STRONG_WEB_PASSWORD';
    END IF;

    EXECUTE format('GRANT CONNECT ON DATABASE %I TO bot_rw', current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO web_ro', current_database());
END
$$;

-- Grant full read/write to bot_rw on all bot tables
GRANT USAGE ON SCHEMA public TO bot_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bot_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bot_rw;

-- Grant strictly read-only access to web_ro, plus UPDATE on `control` row (id=1) ONLY
GRANT USAGE ON SCHEMA public TO web_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM web_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO web_ro;
GRANT UPDATE (new_entries_enabled, updated_at, updated_by) ON TABLE control TO web_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO web_ro;

