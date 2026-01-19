-- Migration 001: Add fixed expenses feature
-- Description: Adds expense_type column to transactions and creates fixed_expenses table
-- Date: 2026-01-18

-- ============================================
-- 1. Add expense_type column to transactions
-- ============================================
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS expense_type VARCHAR(10) DEFAULT 'variable'
CHECK (expense_type IN ('fixed', 'variable'));

-- ============================================
-- 2. Create fixed_expenses table
-- ============================================
CREATE TABLE IF NOT EXISTS fixed_expenses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description VARCHAR(255) NOT NULL,
  typical_amount DECIMAL(12,2) NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  reminder_day INTEGER CHECK (reminder_day BETWEEN 1 AND 31),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 3. Create indexes for performance
-- ============================================
CREATE INDEX IF NOT EXISTS idx_fixed_expenses_user ON fixed_expenses(user_id);
CREATE INDEX IF NOT EXISTS idx_fixed_expenses_reminder ON fixed_expenses(reminder_day, is_active);
CREATE INDEX IF NOT EXISTS idx_transactions_expense_type ON transactions(expense_type);

-- ============================================
-- 4. Add column for conversation state tracking
-- ============================================
-- This tracks when we're waiting for the user to provide a reminder day
ALTER TABLE users
ADD COLUMN IF NOT EXISTS pending_fixed_expense_id INTEGER REFERENCES fixed_expenses(id);

-- ============================================
-- 5. Grant permissions (if needed)
-- ============================================
-- This is typically handled by the database user configuration

-- ============================================
-- Verification queries (run manually to verify)
-- ============================================
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'transactions' AND column_name = 'expense_type';

-- SELECT * FROM information_schema.tables WHERE table_name = 'fixed_expenses';
