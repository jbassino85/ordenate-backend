# Ordenate Backend - Claude Notes

## SQL Syntax for DBeaver (PostgreSQL)

When providing SQL for the user to run in DBeaver, use this syntax:

```sql
-- CREATE TABLE syntax
CREATE TABLE public.table_name (
	column1 varchar NULL,
	column2 int NOT NULL,
	id serial NOT NULL,
	CONSTRAINT table_name_pk PRIMARY KEY (id)
);

-- Foreign keys as separate constraint
ALTER TABLE public.table_name
ADD CONSTRAINT table_name_fk FOREIGN KEY (column_id) REFERENCES public.other_table(id);

-- Indexes (no IF NOT EXISTS)
CREATE INDEX idx_name ON public.table_name (column_name);
```

**Rules:**
- Always use `public.` schema prefix
- PRIMARY KEY as CONSTRAINT at the end, named `tablename_pk`
- Foreign keys as CONSTRAINT, named `tablename_fk` or `tablename_column_fk`
- No `IF NOT EXISTS` for indexes
- Use lowercase `NULL` / `NOT NULL` after data type

## Project Context

- WhatsApp financial assistant for Chile
- Node.js/Express backend with PostgreSQL
- Twilio for WhatsApp integration
- Claude Haiku for intent classification
- Chilean peso formatting (es-CL locale)

## Database Schema (Updated 2026-01-20)

### users
- id (PK), phone, name, created_at, subscription_until
- onboarding_complete, onboarding_step, last_interaction
- savings_goal, monthly_income, last_income_update_prompt, income_update_declined
- pending_fixed_expense_id, last_shown_tx_ids
- plan_id (FK → user_plans.id)

### user_plans
- id (PK), name, price, max_transactions, max_fixed_expenses, description, created_at

### transactions
- id (PK), user_id (FK → users), amount, category_id (FK → categories)
- description, date, is_income, created_at, expense_type
- fixed_expense_id (FK → fixed_expenses)

### fixed_expenses
- id (PK), user_id (FK → users), description, typical_amount
- category_id (FK → categories), reminder_day, is_active, created_at, updated_at

### categories
- id (PK), name, type, emoji, display_order, is_active, created_at

### budgets
- id (PK), user_id (FK → users), category_id (FK → categories), monthly_limit, created_at

### financial_alerts
- id (PK), user_id (FK → users), alert_type, alert_date, created_at

### alerts_sent
- id (PK), user_id (FK → users), alert_type, sent_at, metadata

## Admin Dashboard TODO

### Fase 1: Base de Datos ✅ COMPLETADA
- user_plans table created
- users.plan_id added with FK

### Fase 2: Backend Admin (Pendiente)
- Middleware authenticateAdmin (bcrypt + env var)
- POST /api/admin/login
- GET /api/admin/dashboard (KPIs)
- GET /api/admin/users (lista + filtros)
- GET /api/admin/users/:id (detalle)
- GET /api/admin/stats/* (gráficos)
- Usar last_interaction (no last_activity_at)

### Fase 3: APIs de Costos (Pendiente)
- Claude API: /v1/organizations/usage_report
- Twilio API: /Usage/Records.json
- Railway API: GraphQL

### Fase 4: Frontend Admin (Pendiente)
- HTML en ordenate.ai/admin.html
- Login con password encriptado en env var
- Dashboard con KPIs y gráficos
