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
