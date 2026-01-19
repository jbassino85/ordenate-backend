# Ordenate Backend - Claude Notes

## SQL Syntax for DBeaver

When providing SQL for the user to run in DBeaver, use this syntax:

```sql
-- Correct syntax (with public schema, no IF NOT EXISTS for indexes)
CREATE INDEX idx_name ON public.table_name (column_name);

-- NOT this:
CREATE INDEX IF NOT EXISTS idx_name ON table_name (column_name);
```

## Project Context

- WhatsApp financial assistant for Chile
- Node.js/Express backend with PostgreSQL
- Twilio for WhatsApp integration
- Claude Haiku for intent classification
- Chilean peso formatting (es-CL locale)
