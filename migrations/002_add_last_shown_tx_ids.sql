-- Migration 002: Add last_shown_tx_ids column to users
-- Description: Stores the transaction IDs shown to the user in lists/queries for editing
-- Date: 2026-01-20

-- ============================================
-- 1. Add last_shown_tx_ids column to users
-- ============================================
ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_shown_tx_ids TEXT;

-- This column stores a JSON array of transaction IDs that were shown to the user
-- in the last "mis gastos" or "detalle" query, allowing them to edit/delete by index
